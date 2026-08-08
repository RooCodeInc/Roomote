import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  attachDockerEgressPolicy,
  buildDockerTaskDaemonResourceArgs,
  buildDockerWorkerResourceArgs,
  classifyDockerSpawnError,
  cleanupStaleDockerSandboxes,
  DockerBootError,
  formatDockerCommandError,
  formatSpawnWorkerError,
  getDockerTaskNetworkName,
  getTaskRunErrorCode,
  isUnsupportedDockerDiskLimitError,
  prepareDockerTaskNetwork,
  removeDockerSandboxResources,
  restoreDockerStandbyNetworking,
  sanitizeDockerCommandForDisplay,
  type DockerCommand,
} from '../docker-sandbox-security';
import { TaskRunErrorCode } from '@roomote/types';

const execFileAsync = promisify(execFile);

describe('buildDockerWorkerResourceArgs', () => {
  it('enforces CPU, memory, swap, PID, configured disk, log, and capability bounds', () => {
    expect(
      buildDockerWorkerResourceArgs({
        cpuLimit: 2,
        memoryLimit: '4g',
        pidsLimit: 512,
        diskLimit: '20g',
        logMaxSize: '10m',
        logMaxFiles: 3,
      }),
    ).toEqual([
      '--init',
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--memory-swap',
      '4g',
      '--pids-limit',
      '512',
      '--storage-opt',
      'size=20g',
      '--log-driver',
      'json-file',
      '--log-opt',
      'max-size=10m',
      '--log-opt',
      'max-file=3',
      '--cap-drop',
      'NET_ADMIN',
      '--cap-drop',
      'NET_RAW',
    ]);
  });

  it('runs an init process to reap orphaned browser child processes', () => {
    expect(
      buildDockerWorkerResourceArgs({
        cpuLimit: 2,
        memoryLimit: '4g',
        pidsLimit: 512,
        logMaxSize: '10m',
        logMaxFiles: 3,
      }),
    ).toContain('--init');
  });

  it('omits the storage option when the driver cannot enforce a disk limit', () => {
    expect(
      buildDockerWorkerResourceArgs({
        cpuLimit: 2,
        memoryLimit: '4g',
        pidsLimit: 512,
        logMaxSize: '10m',
        logMaxFiles: 3,
      }),
    ).not.toContain('--storage-opt');
  });
});

describe('buildDockerTaskDaemonResourceArgs', () => {
  it('bounds the daemon without dropping networking capabilities it needs', () => {
    const args = buildDockerTaskDaemonResourceArgs({
      cpuLimit: 2,
      memoryLimit: '8g',
      pidsLimit: 512,
      diskLimit: '20g',
      logMaxSize: '10m',
      logMaxFiles: 3,
    });

    expect(args).toContain('--pids-limit');
    expect(args).toContain('--init');
    expect(args).toEqual(
      expect.arrayContaining(['--memory', '8g', '--memory-swap', '8g']),
    );
    expect(args).not.toContain('--cap-drop');
    expect(args).not.toContain('--storage-opt');
  });
});

describe('DockerCommand signal options', () => {
  it('forwards signal through prepareDockerTaskNetwork runDocker calls', async () => {
    const signal = AbortSignal.abort();
    const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');

    await prepareDockerTaskNetwork(
      {
        taskRunId: 7,
        egressPolicy: 'internet',
        autoRemove: false,
        createdAtMs: 1,
      },
      (args, options) => runDocker(args, { ...options, signal }),
    );

    expect(runDocker).toHaveBeenCalledWith(
      expect.arrayContaining(['network', 'create']),
      expect.objectContaining({ signal }),
    );
  });
});

describe('removeDockerSandboxResources', () => {
  it('removes the task Docker daemon and shared workspace volume', async () => {
    const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');

    await removeDockerSandboxResources(
      {
        containerName: 'roomote-worker-42',
        taskNetwork: 'roomote-task-42',
      },
      runDocker,
    );

    expect(runDocker).toHaveBeenCalledWith(
      ['rm', '-f', 'roomote-worker-42-docker'],
      { allowFailure: true },
    );
    expect(runDocker).toHaveBeenCalledWith(
      ['volume', 'rm', '-f', 'roomote-worker-42-workspace'],
      { allowFailure: true },
    );
  });
});

describe('isUnsupportedDockerDiskLimitError', () => {
  it('recognizes quota capability errors from common Docker storage drivers', () => {
    expect(
      isUnsupportedDockerDiskLimitError({
        stderr:
          "--storage-opt is supported only for overlay over xfs with 'pquota' mount option",
      }),
    ).toBe(true);
    expect(
      isUnsupportedDockerDiskLimitError(
        new Error('image roomote-worker:test not found'),
      ),
    ).toBe(false);
  });
});

describe('prepareDockerTaskNetwork', () => {
  it('creates a dedicated internal network for a no-egress task', async () => {
    const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');

    await expect(
      prepareDockerTaskNetwork(
        {
          taskRunId: 91,
          egressPolicy: 'none',
          autoRemove: true,
          createdAtMs: 1234,
        },
        runDocker,
      ),
    ).resolves.toBe('roomote-task-91');

    expect(runDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        'network',
        'create',
        '--internal',
        'roomote-task-91',
      ]),
    );
  });

  it('requires the API but allows deployments without a preview proxy', async () => {
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (
        args[0] === 'network' &&
        args[1] === 'inspect' &&
        args[2] === 'roomote-control'
      ) {
        return JSON.stringify([
          {
            Id: 'control-network-id',
            Containers: {
              apiContainerId: { Name: 'roomote-api' },
            },
          },
        ]);
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === 'apiContainerId'
      ) {
        return JSON.stringify([
          {
            Config: {
              Labels: { 'com.docker.compose.service': 'api' },
            },
            NetworkSettings: {
              Networks: {
                roomoteControl: {
                  NetworkID: 'control-network-id',
                  Aliases: ['api'],
                },
              },
            },
          },
        ]);
      }
      return '';
    });

    await expect(
      prepareDockerTaskNetwork(
        {
          taskRunId: 95,
          controlNetwork: 'roomote-control',
          egressPolicy: 'internet',
          autoRemove: true,
        },
        runDocker,
      ),
    ).resolves.toBe('roomote-task-95');
    expect(runDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        'network',
        'connect',
        '--alias',
        'api',
        'roomote-task-95',
        'apiContainerId',
      ]),
    );
  });
});

describe('attachDockerEgressPolicy', () => {
  it('installs immutable blackhole routes for known cloud metadata ranges', async () => {
    const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');

    await attachDockerEgressPolicy(
      {
        containerName: 'roomote-worker-92',
        egressPolicy: 'internet',
        image: 'roomote-worker:test',
        platform: 'linux/amd64',
        blockDockerGateway: true,
      },
      runDocker,
    );

    const helperRun = runDocker.mock.calls
      .map(([args]) => args)
      .find((args) => args[0] === 'run');
    expect(helperRun).toEqual(
      expect.arrayContaining([
        '--name',
        'roomote-worker-92-egress-policy',
        '--network',
        'container:roomote-worker-92',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'NET_ADMIN',
        'NET_RAW',
        'roomote-worker:test',
      ]),
    );
    const routeScript = helperRun?.at(-1);
    expect(routeScript).toContain('ip route replace blackhole 169.254.0.0/16');
    expect(routeScript).toContain('ip route replace blackhole 10.0.0.0/8');
    expect(routeScript).toContain('ip route show default');
    expect(routeScript).not.toContain(
      'ip route replace blackhole "$gateway/32"',
    );
    expect(routeScript).toContain(
      'for candidate in iptables-nft iptables-legacy iptables; do',
    );
    expect(routeScript).toContain('"$candidate" -S OUTPUT >/dev/null 2>&1');
    expect(routeScript).toContain(
      '"$iptables_cmd" -C OUTPUT -d "$gateway" -j DROP 2>/dev/null || "$iptables_cmd" -A OUTPUT -d "$gateway" -j DROP',
    );
    expect(routeScript).toContain(
      '"$iptables_cmd" -C FORWARD -d "$gateway" -j DROP 2>/dev/null || "$iptables_cmd" -A FORWARD -d "$gateway" -j DROP',
    );
    expect(routeScript).toContain(
      'no supported iptables backend (nft, legacy, or default)',
    );
    // Upgrades must heal netns state left by controllers that blackholed the
    // gateway route in retained standby workers.
    expect(routeScript).toContain(
      'ip route del blackhole "$gateway/32" 2>/dev/null || true',
    );
  });

  it('generates a syntactically valid shell script for the egress helper', async () => {
    for (const blockDockerGateway of [true, false]) {
      const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');

      await attachDockerEgressPolicy(
        {
          containerName: 'roomote-worker-92',
          egressPolicy: 'internet',
          image: 'roomote-worker:test',
          platform: 'linux/amd64',
          blockDockerGateway,
        },
        runDocker,
      );

      const helperRun = runDocker.mock.calls
        .map(([args]) => args)
        .find((args) => args[0] === 'run');
      const routeScript = helperRun?.at(-1);
      expect(routeScript).toBeTruthy();
      // `sh -n` parses without executing; a syntax error here would make every
      // sandbox spawn fail inside the egress helper container.
      await expect(
        execFileAsync('sh', ['-n', '-c', routeScript!]),
      ).resolves.toBeTruthy();
    }
  });

  it('keeps private host routes reachable for host-based local development', async () => {
    const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');

    await attachDockerEgressPolicy(
      {
        containerName: 'roomote-worker-94',
        egressPolicy: 'internet',
        image: 'roomote-worker:test',
        platform: 'linux/amd64',
        blockDockerGateway: false,
      },
      runDocker,
    );

    const helperRun = runDocker.mock.calls
      .map(([args]) => args)
      .find((args) => args[0] === 'run');
    const routeScript = helperRun?.at(-1);
    expect(routeScript).not.toContain('ip route show default');
    expect(routeScript).not.toContain('ip route replace blackhole 10.0.0.0/8');
    expect(routeScript).not.toContain(
      'ip route replace blackhole 172.16.0.0/12',
    );
    expect(routeScript).not.toContain(
      'ip route replace blackhole 192.168.0.0/16',
    );
    expect(routeScript).toContain('ip route replace blackhole 169.254.0.0/16');
  });
});

describe('restoreDockerStandbyNetworking', () => {
  it('re-applies egress routes and reconnects recreated trusted services', async () => {
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (
        args[0] === 'network' &&
        args[1] === 'inspect' &&
        args[2] === 'roomote-control'
      ) {
        return JSON.stringify([
          {
            Id: 'control-network-id',
            Containers: {
              apiContainerId: { Name: 'roomote-api' },
              previewContainerId: { Name: 'roomote-preview-proxy' },
            },
          },
        ]);
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === 'apiContainerId'
      ) {
        return JSON.stringify([
          {
            Config: { Labels: { 'com.docker.compose.service': 'api' } },
            NetworkSettings: {
              Networks: {
                control: {
                  NetworkID: 'control-network-id',
                  Aliases: ['api'],
                },
              },
            },
          },
        ]);
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === 'previewContainerId'
      ) {
        return JSON.stringify([
          {
            Config: {
              Labels: { 'com.docker.compose.service': 'preview-proxy' },
            },
            NetworkSettings: {
              Networks: {
                control: {
                  NetworkID: 'control-network-id',
                  Aliases: ['preview-proxy'],
                },
              },
            },
          },
        ]);
      }
      return '';
    });

    await restoreDockerStandbyNetworking(
      {
        containerName: 'roomote-worker-96',
        taskNetwork: 'roomote-task-96',
        controlNetwork: 'roomote-control',
        egressPolicy: 'internet',
        image: 'roomote-worker:test',
        platform: 'linux/amd64',
      },
      runDocker,
    );

    expect(runDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        'run',
        '--network',
        'container:roomote-worker-96',
        'roomote-worker:test',
      ]),
    );
    expect(runDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        'network',
        'connect',
        'roomote-task-96',
        'apiContainerId',
      ]),
    );
    expect(runDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        'network',
        'connect',
        'roomote-task-96',
        'previewContainerId',
      ]),
    );
  });
});

describe('cleanupStaleDockerSandboxes', () => {
  it('uses container-specific inspection when a stale worker no longer exists', async () => {
    const taskNetwork = getDockerTaskNetworkName(27);
    const containerName = 'roomote-worker-27';
    const nowMs = 20 * 60 * 1_000;
    const createdAtMs = 1_000;
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (args[0] === 'network' && args[1] === 'ls') {
        return `${taskNetwork}\n`;
      }
      if (
        args[0] === 'network' &&
        args[1] === 'inspect' &&
        args[2] === taskNetwork
      ) {
        return JSON.stringify([
          {
            Labels: {
              'dev.roomote.sandbox.container': containerName,
              'dev.roomote.sandbox.managed': 'true',
              'dev.roomote.sandbox.auto-remove': 'true',
              'dev.roomote.sandbox.created-at-ms': String(createdAtMs),
            },
          },
        ]);
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === containerName
      ) {
        throw new Error(`No such container: ${containerName}`);
      }
      return '';
    });

    await cleanupStaleDockerSandboxes({ nowMs }, runDocker);

    expect(runDocker).toHaveBeenCalledWith([
      'container',
      'inspect',
      containerName,
    ]);
    expect(runDocker).not.toHaveBeenCalledWith(['inspect', containerName]);
    expect(runDocker).toHaveBeenCalledWith(['network', 'rm', taskNetwork], {
      allowFailure: true,
    });
  });

  it('removes an old orphan network after disconnecting trusted peers', async () => {
    const taskNetwork = getDockerTaskNetworkName(92);
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (args[0] === 'network' && args[1] === 'ls') {
        return `${taskNetwork}\n`;
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return JSON.stringify([
          {
            Labels: {
              'dev.roomote.sandbox.container': 'roomote-worker-92',
              'dev.roomote.sandbox.auto-remove': 'true',
              'dev.roomote.task-run-id': '92',
              'dev.roomote.sandbox.created-at-ms': '1000',
            },
            Containers: { api123: { Name: 'roomote-api' } },
          },
        ]);
      }
      return '';
    });

    await cleanupStaleDockerSandboxes({ nowMs: 20 * 60 * 1_000 }, runDocker);

    expect(runDocker).toHaveBeenCalledWith(
      ['network', 'disconnect', '-f', taskNetwork, 'api123'],
      { allowFailure: true },
    );
    expect(runDocker).toHaveBeenCalledWith(['network', 'rm', taskNetwork], {
      allowFailure: true,
    });
  });

  it('removes a stopped auto-remove container and disconnects trusted peers after a controller restart', async () => {
    const taskNetwork = getDockerTaskNetworkName(93);
    const networkInspect = JSON.stringify([
      {
        Labels: {
          'dev.roomote.sandbox.container': 'roomote-worker-93',
          'dev.roomote.sandbox.auto-remove': 'true',
          'dev.roomote.task-run-id': '93',
          'dev.roomote.sandbox.created-at-ms': '1000',
        },
        Containers: {
          api123: { Name: 'roomote-api' },
          worker123: { Name: 'roomote-worker-93' },
        },
      },
    ]);
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (args[0] === 'network' && args[1] === 'ls') {
        return `${taskNetwork}\n`;
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return networkInspect;
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === 'roomote-worker-93'
      ) {
        return JSON.stringify([{ State: { Running: false } }]);
      }
      return '';
    });

    await cleanupStaleDockerSandboxes({ nowMs: 20_000 }, runDocker);

    expect(runDocker).toHaveBeenCalledWith([
      'container',
      'inspect',
      'roomote-worker-93',
    ]);
    expect(runDocker).toHaveBeenCalledWith(['rm', '-f', 'roomote-worker-93'], {
      allowFailure: true,
    });
    expect(runDocker).toHaveBeenCalledWith(
      ['network', 'disconnect', '-f', taskNetwork, 'api123'],
      { allowFailure: true },
    );
    expect(runDocker).toHaveBeenCalledWith(['network', 'rm', taskNetwork], {
      allowFailure: true,
    });
  });

  it('reattaches a replacement API container to a running task network', async () => {
    const taskNetwork = getDockerTaskNetworkName(96);
    const controlNetwork = 'roomote-control';
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (args[0] === 'network' && args[1] === 'ls') {
        return `${taskNetwork}\n`;
      }
      if (
        args[0] === 'network' &&
        args[1] === 'inspect' &&
        args[2] === taskNetwork
      ) {
        return JSON.stringify([
          {
            Id: 'task-network-id',
            Labels: {
              'dev.roomote.sandbox.container': 'roomote-worker-96',
              'dev.roomote.sandbox.auto-remove': 'true',
              'dev.roomote.task-run-id': '96',
              'dev.roomote.sandbox.created-at-ms': '1000',
            },
          },
        ]);
      }
      if (
        args[0] === 'network' &&
        args[1] === 'inspect' &&
        args[2] === controlNetwork
      ) {
        return JSON.stringify([
          {
            Id: 'control-network-id',
            Containers: { replacementApi: { Name: 'roomote-api-new' } },
          },
        ]);
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === 'roomote-worker-96'
      ) {
        return JSON.stringify([{ State: { Running: true } }]);
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === 'replacementApi'
      ) {
        return JSON.stringify([
          {
            Config: { Labels: { 'com.docker.compose.service': 'api' } },
            NetworkSettings: {
              Networks: {
                [controlNetwork]: {
                  NetworkID: 'control-network-id',
                  Aliases: ['api'],
                },
              },
            },
          },
        ]);
      }
      if (args[0] === 'exec') {
        return 'worker run 96';
      }
      return '';
    });

    await cleanupStaleDockerSandboxes(
      { nowMs: 20 * 60 * 1_000, controlNetwork },
      runDocker,
    );

    expect(runDocker).toHaveBeenCalledWith([
      'network',
      'connect',
      '--alias',
      'api',
      '--alias',
      'roomote-api-new',
      taskNetwork,
      'replacementApi',
    ]);
    expect(runDocker).not.toHaveBeenCalledWith(
      ['rm', '-f', 'roomote-worker-96'],
      expect.anything(),
    );
  });

  it('skips a network whose inspection fails without removing it or aborting the sweep', async () => {
    const failingNetwork = getDockerTaskNetworkName(97);
    const orphanedNetwork = getDockerTaskNetworkName(98);
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (args[0] === 'network' && args[1] === 'ls') {
        return `${failingNetwork}\n${orphanedNetwork}\n`;
      }
      if (
        args[0] === 'network' &&
        args[1] === 'inspect' &&
        args[2] === failingNetwork
      ) {
        throw new Error('Docker daemon unavailable');
      }
      if (
        args[0] === 'network' &&
        args[1] === 'inspect' &&
        args[2] === orphanedNetwork
      ) {
        return JSON.stringify([{ Labels: {} }]);
      }
      return '';
    });

    await expect(
      cleanupStaleDockerSandboxes({ nowMs: 20 * 60 * 1_000 }, runDocker),
    ).resolves.toBeUndefined();
    expect(runDocker).not.toHaveBeenCalledWith(
      ['network', 'rm', failingNetwork],
      expect.anything(),
    );
    // The failing network must not stop later networks from being reconciled.
    expect(runDocker).toHaveBeenCalledWith(
      ['network', 'rm', orphanedNetwork],
      expect.anything(),
    );
  });

  it('keeps a running container whose process list cannot be read or whose task-run label is corrupt', async () => {
    for (const taskRunLabel of ['99', 'not-a-number']) {
      const taskNetwork = getDockerTaskNetworkName(99);
      const containerName = 'roomote-worker-99';
      const runDocker = vi.fn<DockerCommand>(async (args) => {
        if (args[0] === 'network' && args[1] === 'ls') {
          return `${taskNetwork}\n`;
        }
        if (args[0] === 'network' && args[1] === 'inspect') {
          return JSON.stringify([
            {
              Labels: {
                'dev.roomote.sandbox.container': containerName,
                'dev.roomote.sandbox.auto-remove': 'true',
                'dev.roomote.task-run-id': taskRunLabel,
                'dev.roomote.sandbox.created-at-ms': '1000',
              },
            },
          ]);
        }
        if (
          args[0] === 'container' &&
          args[1] === 'inspect' &&
          args[2] === containerName
        ) {
          return JSON.stringify([{ State: { Running: true } }]);
        }
        if (args[0] === 'exec') {
          throw new Error('container is restarting');
        }
        return '';
      });

      await cleanupStaleDockerSandboxes({ nowMs: 20 * 60 * 1_000 }, runDocker);

      expect(runDocker).not.toHaveBeenCalledWith(
        ['rm', '-f', containerName],
        expect.anything(),
      );
      expect(runDocker).not.toHaveBeenCalledWith(
        ['network', 'rm', taskNetwork],
        expect.anything(),
      );
    }
  });

  it('tolerates losing the inspect-then-connect race for a trusted service', async () => {
    const taskNetwork = getDockerTaskNetworkName(95);
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (
        args[0] === 'network' &&
        args[1] === 'inspect' &&
        args[2] === 'roomote-control'
      ) {
        return JSON.stringify([
          {
            Id: 'control-network-id',
            Containers: { apiContainerId: { Name: 'roomote-api' } },
          },
        ]);
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === 'apiContainerId'
      ) {
        return JSON.stringify([
          {
            Config: { Labels: { 'com.docker.compose.service': 'api' } },
            NetworkSettings: {
              Networks: {
                roomoteControl: {
                  NetworkID: 'control-network-id',
                  Aliases: ['api'],
                },
              },
            },
          },
        ]);
      }
      if (args[0] === 'network' && args[1] === 'connect') {
        throw new Error(
          `endpoint with name roomote-api already exists in network ${taskNetwork}`,
        );
      }
      return '';
    });

    await expect(
      prepareDockerTaskNetwork(
        {
          taskRunId: 95,
          controlNetwork: 'roomote-control',
          egressPolicy: 'internet',
          autoRemove: true,
        },
        runDocker,
      ),
    ).resolves.toBe(taskNetwork);
  });
});

describe('formatDockerCommandError', () => {
  it('leads with Docker stderr instead of the raw argv list', () => {
    const message = formatDockerCommandError(
      ['run', '-d', 'roomote-worker:local'],
      {
        message: 'Command failed: docker run -d roomote-worker:local',
        cmd: 'docker run -d roomote-worker:local',
        code: 125,
        stderr:
          "Unable to find image 'roomote-worker:local' locally\ndocker: Error response from daemon: pull access denied for roomote-worker, repository does not exist or may require 'docker login'\n",
        stdout: '',
      },
    );

    expect(message.startsWith('Failed to run docker run.')).toBe(true);
    expect(message).toContain('pull access denied for roomote-worker');
    expect(message.indexOf('pull access denied')).toBeLessThan(
      message.indexOf('command:'),
    );
  });

  it('redacts docker -e environment values from command diagnostics', () => {
    const message = formatDockerCommandError(
      ['exec', '-e', 'AUTH_TOKEN=super-secret', 'roomote-worker-1', 'true'],
      {
        message: 'Command failed',
        cmd: 'docker exec -e AUTH_TOKEN=super-secret roomote-worker-1 true',
        code: 1,
        stderr: 'container not running',
        stdout: '',
      },
    );

    expect(message).toContain('AUTH_TOKEN=<redacted>');
    expect(message).not.toContain('super-secret');
    expect(
      sanitizeDockerCommandForDisplay([
        'exec',
        '-e',
        'AUTH_TOKEN=super-secret',
        'roomote-worker-1',
      ]),
    ).toBe('docker exec -e AUTH_TOKEN=<redacted> roomote-worker-1');
  });

  it('redacts auth tokens when reason falls back to raw error.message', () => {
    const message = formatDockerCommandError(
      ['exec', '-e', 'AUTH_TOKEN=super-secret', 'roomote-worker-1', 'true'],
      {
        message:
          'Command failed: docker exec -e AUTH_TOKEN=super-secret roomote-worker-1 true',
        cmd: 'docker exec -e AUTH_TOKEN=super-secret roomote-worker-1 true',
        code: 1,
        stderr: '',
        stdout: '',
      },
    );

    expect(message).toContain('AUTH_TOKEN=<redacted>');
    expect(message).not.toContain('super-secret');
    expect(formatSpawnWorkerError(new Error(message))).not.toContain(
      'super-secret',
    );
  });

  it('redacts auth tokens embedded in stderr/stdout diagnostics', () => {
    const message = formatDockerCommandError(
      ['run', '-d', 'roomote-worker:local'],
      {
        message: 'Command failed',
        cmd: 'docker run -d roomote-worker:local',
        code: 1,
        stderr:
          'failed: docker exec -e AUTH_TOKEN=super-secret roomote-worker-1 true',
        stdout:
          'retry: docker exec -e AUTH_TOKEN=super-secret roomote-worker-1 true',
      },
    );

    expect(message).toContain('AUTH_TOKEN=<redacted>');
    expect(message).not.toContain('super-secret');
  });

  it('formats plain Error messages for finishRun storage', () => {
    expect(formatSpawnWorkerError(new Error('Machine unavailable'))).toBe(
      'Machine unavailable',
    );
    expect(
      formatSpawnWorkerError(
        new Error(
          'Failed to run docker run.\n\npull access denied\n\ncommand:\ndocker run -d x',
        ),
      ),
    ).toContain('Failed to run docker run');
  });
});

describe('docker spawn error wrapping', () => {
  it('exposes a pure helper that never attaches a raw execFile cause', () => {
    const raw = Object.assign(
      new Error(
        'Command failed: docker exec -e AUTH_TOKEN=super-secret c true',
      ),
      {
        cmd: 'docker exec -e AUTH_TOKEN=super-secret c true',
        stderr: '',
        stdout: '',
        code: 1,
      },
    );

    const message = formatDockerCommandError(
      ['exec', '-e', 'AUTH_TOKEN=super-secret', 'c', 'true'],
      raw,
    );
    // Mirrors apps/controller docker() throw site: sanitized message, no cause.
    const thrown = new Error(message);

    expect(thrown.message).toContain('AUTH_TOKEN=<redacted>');
    expect(thrown.message).not.toContain('super-secret');
    expect(thrown.cause).toBeUndefined();
  });
});

describe('classifyDockerSpawnError', () => {
  it('categorizes daemon, image, port, and archive failures', () => {
    expect(
      classifyDockerSpawnError(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      ),
    ).toBe(TaskRunErrorCode.DockerDaemonUnreachable);
    expect(
      classifyDockerSpawnError(
        "pull access denied for roomote-worker, repository does not exist or may require 'docker login'",
      ),
    ).toBe(TaskRunErrorCode.DockerImageMissing);
    expect(
      classifyDockerSpawnError(
        'driver failed programming external connectivity: Bind for 127.0.0.1:13000 failed: port is already allocated',
      ),
    ).toBe(TaskRunErrorCode.DockerPortInUse);
    expect(
      classifyDockerSpawnError(
        'Docker worker release archive does not exist: /releases/worker.tar.gz',
      ),
    ).toBe(TaskRunErrorCode.DockerReleaseArchiveMissing);
    expect(
      classifyDockerSpawnError(
        'Error response from daemon: all predefined address pools have been fully subnetted',
      ),
    ).toBe(TaskRunErrorCode.DockerAddressPoolExhausted);
  });

  it('returns undefined for failures with no mapped category', () => {
    expect(classifyDockerSpawnError('Machine unavailable')).toBeUndefined();
  });
});

describe('DockerBootError', () => {
  it('carries a code readable via getTaskRunErrorCode', () => {
    const error = new DockerBootError(
      TaskRunErrorCode.DockerImageMissing,
      'Docker worker image roomote-worker:local is not available locally and could not be pulled.',
    );

    expect(getTaskRunErrorCode(error)).toBe(
      TaskRunErrorCode.DockerImageMissing,
    );
    expect(getTaskRunErrorCode(new Error('plain'))).toBeUndefined();
    expect(getTaskRunErrorCode('string error')).toBeUndefined();
  });
});

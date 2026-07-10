import { describe, expect, it, vi } from 'vitest';

import {
  attachDockerEgressPolicy,
  buildDockerWorkerResourceArgs,
  cleanupStaleDockerSandboxes,
  getDockerTaskNetworkName,
  isUnsupportedDockerDiskLimitError,
  prepareDockerTaskNetwork,
  type DockerCommand,
} from '../docker-sandbox-security';

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
      if (args[0] === 'inspect' && args[1] === 'apiContainerId') {
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
        'roomote-worker:test',
      ]),
    );
    const routeScript = helperRun?.at(-1);
    expect(routeScript).toContain('ip route add blackhole 169.254.0.0/16');
    expect(routeScript).toContain('ip route add blackhole 10.0.0.0/8');
    expect(routeScript).toContain('ip route show default');
    expect(routeScript).toContain('ip route add blackhole "$gateway/32"');
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
    expect(routeScript).not.toContain('ip route add blackhole 10.0.0.0/8');
    expect(routeScript).not.toContain('ip route add blackhole 172.16.0.0/12');
    expect(routeScript).not.toContain('ip route add blackhole 192.168.0.0/16');
    expect(routeScript).toContain('ip route add blackhole 169.254.0.0/16');
  });
});

describe('cleanupStaleDockerSandboxes', () => {
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
      if (args[0] === 'inspect' && args[1] === 'roomote-worker-93') {
        return JSON.stringify([{ State: { Running: false } }]);
      }
      return '';
    });

    await cleanupStaleDockerSandboxes({ nowMs: 20_000 }, runDocker);

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
      if (args[0] === 'inspect' && args[1] === 'roomote-worker-96') {
        return JSON.stringify([{ State: { Running: true } }]);
      }
      if (args[0] === 'inspect' && args[1] === 'replacementApi') {
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

  it('does not remove task resources when Docker inspection fails', async () => {
    const taskNetwork = getDockerTaskNetworkName(97);
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (args[0] === 'network' && args[1] === 'ls') {
        return `${taskNetwork}\n`;
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        throw new Error('Docker daemon unavailable');
      }
      return '';
    });

    await expect(
      cleanupStaleDockerSandboxes({ nowMs: 20 * 60 * 1_000 }, runDocker),
    ).rejects.toThrow('Docker daemon unavailable');
    expect(runDocker).not.toHaveBeenCalledWith(
      ['network', 'rm', taskNetwork],
      expect.anything(),
    );
    expect(runDocker).not.toHaveBeenCalledWith(
      expect.arrayContaining(['network', 'disconnect']),
      expect.anything(),
    );
  });
});

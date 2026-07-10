import { describe, expect, it, vi } from 'vitest';

import {
  attachDockerEgressPolicy,
  buildDockerWorkerResourceArgs,
  cleanupStaleDockerSandboxes,
  getDockerTaskNetworkName,
  prepareDockerTaskNetwork,
  type DockerCommand,
} from '../docker-sandbox-security';

describe('buildDockerWorkerResourceArgs', () => {
  it('enforces CPU, memory, swap, PID, disk, log, and capability bounds', () => {
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

  it('keeps the Docker gateway reachable for host-based local development', async () => {
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
    expect(helperRun?.at(-1)).not.toContain('ip route show default');
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
});

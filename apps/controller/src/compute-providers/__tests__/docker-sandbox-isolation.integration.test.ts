import { afterAll, describe, expect, it } from 'vitest';

import {
  attachDockerEgressPolicy,
  buildDockerWorkerResourceArgs,
  cleanupStaleDockerSandboxes,
  docker,
  getDockerTaskNetworkName,
  getDockerWorkerContainerName,
  prepareDockerTaskNetwork,
  removeDockerSandboxResources,
} from '../docker-sandbox-security';

const runIntegrationTests =
  process.env.RUN_DOCKER_SANDBOX_INTEGRATION_TESTS === 'true';
const dockerImage = process.env.DOCKER_SANDBOX_TEST_IMAGE ?? 'alpine:3.20';
const firstTaskRunId = 900_000_000 + process.pid * 2;
const taskRunIds = [firstTaskRunId, firstTaskRunId + 1];
const controlNetwork = `roomote-isolation-test-${process.pid}`;
const trustedContainers = [
  `roomote-isolation-api-${process.pid}`,
  `roomote-isolation-preview-${process.pid}`,
];
const resourceArgs = buildDockerWorkerResourceArgs({
  cpuLimit: 0.25,
  memoryLimit: '64m',
  pidsLimit: 64,
  diskLimit: '128m',
  logMaxSize: '1m',
  logMaxFiles: 2,
});

describe.runIf(runIntegrationTests)('Docker task network isolation', () => {
  afterAll(async () => {
    await Promise.all(
      taskRunIds.map((taskRunId) =>
        removeDockerSandboxResources({
          containerName: getDockerWorkerContainerName(taskRunId),
          taskNetwork: getDockerTaskNetworkName(taskRunId),
        }),
      ),
    );
    await Promise.all(
      trustedContainers.map((containerName) =>
        docker(['rm', '-f', containerName], { allowFailure: true }),
      ),
    );
    await docker(['network', 'rm', controlNetwork], { allowFailure: true });
  });

  it('prevents one task from reaching another task sandbox server, preview port, or credential endpoint', async () => {
    await docker(['network', 'create', controlNetwork]);
    for (const [index, service] of ['api', 'preview-proxy'].entries()) {
      await docker([
        'run',
        '-d',
        '--rm',
        '--name',
        trustedContainers[index]!,
        '--label',
        `com.docker.compose.service=${service}`,
        '--network',
        controlNetwork,
        '--network-alias',
        service,
        dockerImage,
        ...(service === 'api'
          ? ['sh', '-c', 'while true; do echo api | nc -l -p 7777; done']
          : ['sleep', 'infinity']),
      ]);
    }

    for (const taskRunId of taskRunIds) {
      await prepareDockerTaskNetwork({
        taskRunId,
        controlNetwork,
        egressPolicy: 'internet',
        autoRemove: true,
      });
    }

    const sourceContainer = getDockerWorkerContainerName(taskRunIds[0]!);
    const targetContainer = getDockerWorkerContainerName(taskRunIds[1]!);

    await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      sourceContainer,
      '--network',
      getDockerTaskNetworkName(taskRunIds[0]!),
      ...resourceArgs,
      dockerImage,
      'sleep',
      'infinity',
    ]);
    await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      targetContainer,
      '--network',
      getDockerTaskNetworkName(taskRunIds[1]!),
      '--env',
      'SIBLING_CREDENTIAL=must-not-leak',
      ...resourceArgs,
      dockerImage,
      'sh',
      '-c',
      [
        'while true; do echo sandbox | nc -l -p 4200; done &',
        'while true; do echo preview | nc -l -p 3000; done &',
        'while true; do echo "$SIBLING_CREDENTIAL" | nc -l -p 8080; done &',
        'wait',
      ].join(' '),
    ]);
    await attachDockerEgressPolicy({
      containerName: sourceContainer,
      egressPolicy: 'internet',
      image: dockerImage,
      platform: process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
      blockDockerGateway: true,
    });
    await attachDockerEgressPolicy({
      containerName: targetContainer,
      egressPolicy: 'internet',
      image: dockerImage,
      platform: process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
      blockDockerGateway: true,
    });

    const hostConfig = JSON.parse(
      await docker([
        'inspect',
        sourceContainer,
        '--format',
        '{{json .HostConfig}}',
      ]),
    ) as {
      NanoCpus: number;
      Memory: number;
      MemorySwap: number;
      PidsLimit: number;
      CapDrop: string[];
      StorageOpt: Record<string, string>;
      LogConfig: { Type: string; Config: Record<string, string> };
    };
    expect(hostConfig).toMatchObject({
      NanoCpus: 250_000_000,
      Memory: 64 * 1024 * 1024,
      MemorySwap: 64 * 1024 * 1024,
      PidsLimit: 64,
      CapDrop: ['CAP_NET_ADMIN', 'CAP_NET_RAW'],
      StorageOpt: { size: '128m' },
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-file': '2', 'max-size': '1m' },
      },
    });

    const routes = await docker([
      'exec',
      sourceContainer,
      'ip',
      'route',
      'show',
    ]);
    expect(routes).toContain('blackhole 169.254.0.0/16');
    expect(routes).toContain('blackhole 100.64.0.0/10');
    expect(routes).toContain('blackhole 192.0.0.0/24');
    expect(routes).toContain('blackhole 10.0.0.0/8');
    expect(routes).toContain('blackhole 172.16.0.0/12');
    expect(routes).toContain('blackhole 192.168.0.0/16');
    const defaultGateway = routes.match(/default via ([\d.]+)/)?.[1];
    expect(defaultGateway).toBeTruthy();
    expect(routes).toContain(`blackhole ${defaultGateway}`);
    await expect(
      docker(['exec', sourceContainer, 'ip', 'route', 'get', '1.1.1.1']),
    ).resolves.toContain('via');
    await expect(
      docker(['exec', sourceContainer, 'nc', '-z', '-w', '1', 'api', '7777']),
    ).resolves.toBe('');
    await expect(
      docker([
        'exec',
        trustedContainers[1]!,
        'nc',
        '-z',
        '-w',
        '1',
        targetContainer,
        '4200',
      ]),
    ).resolves.toBe('');

    const targetIp = (
      await docker([
        'inspect',
        targetContainer,
        '--format',
        `{{(index .NetworkSettings.Networks "${getDockerTaskNetworkName(taskRunIds[1]!)}").IPAddress}}`,
      ])
    ).trim();

    await expect(
      docker([
        'exec',
        sourceContainer,
        'timeout',
        '2',
        'getent',
        'hosts',
        targetContainer,
      ]),
    ).rejects.toThrow();

    for (const port of ['4200', '3000', '8080']) {
      await expect(
        docker([
          'exec',
          sourceContainer,
          'nc',
          '-z',
          '-w',
          '1',
          targetIp,
          port,
        ]),
      ).rejects.toThrow();
    }

    // Simulate a controller crash during provisioning: the task networks and
    // sleep-only containers survive, then the restarted controller's reaper
    // observes that no worker process began within the provisioning window.
    await cleanupStaleDockerSandboxes({
      nowMs: Date.now() + 16 * 60 * 1_000,
    });

    for (const taskRunId of taskRunIds) {
      await expect(
        docker(['inspect', getDockerWorkerContainerName(taskRunId)]),
      ).rejects.toThrow();
      await expect(
        docker(['network', 'inspect', getDockerTaskNetworkName(taskRunId)]),
      ).rejects.toThrow();
    }
  }, 30_000);
});

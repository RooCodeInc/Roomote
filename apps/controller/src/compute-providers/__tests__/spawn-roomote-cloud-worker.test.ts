import type { TaskRun } from '@roomote/db/server';

const {
  mockLaunchRoomoteCloudCompute,
  mockUpdateTaskRunMachine,
  mockStampTaskRunMilestone,
} = vi.hoisted(() => ({
  mockLaunchRoomoteCloudCompute: vi.fn(),
  mockUpdateTaskRunMachine: vi.fn(),
  mockStampTaskRunMilestone: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { TRPC_URL: 'http://api', R_APP_URL: 'http://app' },
}));

vi.mock('@roomote/compute-providers', () => ({
  buildDockerWorkerEnv: (input: { extraEnv: Record<string, string> }) => ({
    ...input.extraEnv,
    COMPUTE_PROVIDER: 'docker',
    ROOMOTE_WORKER_COMPUTE_PROVIDER: 'docker',
  }),
  resolveAuthBypassHeaderName: vi.fn(),
  resolveAuthBypassValue: vi.fn(),
}));

vi.mock('@roomote/types', () => ({
  SANDBOX_SERVER_PORT: 4200,
  getPrimaryPortFromConfig: () => undefined,
}));

vi.mock('@roomote/sdk/server', () => ({
  stampTaskRunMilestone: (...args: unknown[]) =>
    mockStampTaskRunMilestone(...args),
}));

vi.mock('../../utils', () => ({
  getNamedPortsForTaskRun: vi.fn().mockResolvedValue({
    namedPorts: [{ name: 'sandbox', port: 4200 }],
    environmentConfig: null,
  }),
  shouldEnableAuthBypassForTaskRun: () => false,
  updateTaskRunMachine: (...args: unknown[]) =>
    mockUpdateTaskRunMachine(...args),
}));

vi.mock('../../roomote-cloud-runtime', () => ({
  launchRoomoteCloudCompute: (...args: unknown[]) =>
    mockLaunchRoomoteCloudCompute(...args),
}));

vi.mock('../spawn-docker-worker', () => ({
  toContainerReachableUrl: (url: string) => url,
}));

import { spawnRoomoteCloudWorker } from '../spawn-roomote-cloud-worker';

describe('spawnRoomoteCloudWorker', () => {
  it('persists the opaque Cloud lease and hides the broker machine id', async () => {
    mockLaunchRoomoteCloudCompute.mockResolvedValue({
      id: 'lease-1',
      provider: 'e2b',
      machineId: 'underlying-sandbox-1',
      status: 'ready',
      proxyPorts: { '4200': 4200 },
      portUrls: { '4200': 'https://sandbox.example' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockUpdateTaskRunMachine.mockResolvedValue(undefined);
    mockStampTaskRunMilestone.mockResolvedValue(undefined);

    const taskRun = {
      id: 42,
      taskId: 'task-42',
      payload: { environmentId: 'environment-1' },
    } as TaskRun;
    await spawnRoomoteCloudWorker({
      taskRun,
      authToken: 'run-token',
      deploymentSlug: 'hosted',
      timeoutMs: 60_000,
      cloudConfig: {
        baseUrl: 'https://cloud.example',
        deploymentToken: 'deployment-token',
      },
      managedRuntimeEnv: {
        ROOMOTE_CLOUD_INFERENCE_TOKEN: 'inference-token',
      },
    });

    expect(mockLaunchRoomoteCloudCompute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environment: expect.objectContaining({
          COMPUTE_PROVIDER: 'roomote',
          ROOMOTE_WORKER_COMPUTE_PROVIDER: 'roomote',
        }),
      }),
    );
    expect(mockUpdateTaskRunMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRun,
        vendor: 'roomote',
        machineId: 'lease-1',
        sandboxServerUrl: 'https://sandbox.example',
      }),
    );
    expect(JSON.stringify(mockUpdateTaskRunMachine.mock.calls)).not.toContain(
      'underlying-sandbox-1',
    );
  });
});

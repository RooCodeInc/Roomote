import type { TaskRun } from '@roomote/db/server';

const {
  mockLaunchRoomoteCloudCompute,
  mockStopRoomoteCloudCompute,
  mockUpdateTaskRunMachine,
  mockStampTaskRunMilestone,
} = vi.hoisted(() => ({
  mockLaunchRoomoteCloudCompute: vi.fn(),
  mockStopRoomoteCloudCompute: vi.fn(),
  mockUpdateTaskRunMachine: vi.fn(),
  mockStampTaskRunMilestone: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { TRPC_URL: 'http://api', R_APP_URL: 'http://app' },
}));

vi.mock('@roomote/db/server', () => ({
  count: () => 'count',
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve([{ total: 3 }]) }),
    }),
  },
  isNull: () => 'is-null',
  users: { deletedAt: 'deleted-at' },
}));

vi.mock('@roomote/compute-providers', () => ({
  buildDockerWorkerEnv: (input: { extraEnv: Record<string, string> }) => ({
    ...input.extraEnv,
    R_MODEL: 'anthropic/claude-sonnet',
    ANTHROPIC_API_KEY: 'customer-key',
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
  stopRoomoteCloudCompute: (...args: unknown[]) =>
    mockStopRoomoteCloudCompute(...args),
}));

vi.mock('../spawn-docker-worker', () => ({
  toContainerReachableUrl: (url: string) => url,
}));

import { spawnRoomoteCloudWorker } from '../spawn-roomote-cloud-worker';

describe('spawnRoomoteCloudWorker', () => {
  beforeEach(() => {
    mockLaunchRoomoteCloudCompute.mockReset();
    mockStopRoomoteCloudCompute.mockReset();
    mockUpdateTaskRunMachine.mockReset();
    mockStampTaskRunMilestone.mockReset();
  });

  it('persists the opaque Cloud lease and preserves customer model env', async () => {
    mockLaunchRoomoteCloudCompute.mockResolvedValue({
      id: 'lease-1',
      provider: 'roomote-cloud',
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
    });

    expect(mockLaunchRoomoteCloudCompute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        activeSeatCount: 3,
        environment: expect.objectContaining({
          R_MODEL: 'anthropic/claude-sonnet',
          ANTHROPIC_API_KEY: 'customer-key',
          COMPUTE_PROVIDER: 'roomote-cloud',
          ROOMOTE_WORKER_COMPUTE_PROVIDER: 'roomote-cloud',
        }),
      }),
    );
    expect(mockUpdateTaskRunMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRun,
        vendor: 'roomote-cloud',
        machineId: 'lease-1',
        sandboxServerUrl: 'https://sandbox.example',
      }),
    );
    expect(JSON.stringify(mockUpdateTaskRunMachine.mock.calls)).not.toContain(
      'underlying-sandbox-1',
    );
  });

  it('stops a lease if local persistence fails', async () => {
    mockLaunchRoomoteCloudCompute.mockResolvedValue({
      id: 'lease-2',
      provider: 'roomote-cloud',
      status: 'ready',
      proxyPorts: { '4200': 4200 },
      portUrls: { '4200': 'https://sandbox.example' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockUpdateTaskRunMachine.mockRejectedValue(new Error('database failed'));
    mockStopRoomoteCloudCompute.mockResolvedValue(undefined);

    await expect(
      spawnRoomoteCloudWorker({
        taskRun: {
          id: 43,
          taskId: 'task-43',
          payload: {},
        } as TaskRun,
        authToken: 'run-token',
        deploymentSlug: 'hosted',
        timeoutMs: 60_000,
        cloudConfig: {
          baseUrl: 'https://cloud.example',
          deploymentToken: 'deployment-token',
        },
      }),
    ).rejects.toThrow('database failed');
    expect(mockStopRoomoteCloudCompute).toHaveBeenCalledWith(
      expect.anything(),
      'lease-2',
    );
  });
});

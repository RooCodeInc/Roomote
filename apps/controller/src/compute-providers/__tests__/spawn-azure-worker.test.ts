import type { TaskRun } from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

const mockCreateAzureMachine = vi.fn();
const mockRunCommand = vi.fn();
const mockRecordMutation = vi.fn();
const mockCreateComputeProviderClient = vi.fn((_arg?: unknown) => ({
  runCommand: mockRunCommand,
}));
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockDbUpdate = vi.fn(() => ({ set: mockUpdateSet }));
const mockUpdateTaskRunMachine = vi.fn();
const mockGetNamedPortsForTaskRun = vi.fn();
const mockPrimeEnvironmentOidcForMachine = vi.fn();
const mockFindTask = vi.fn();

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    db: {
      ...actual.db,
      query: {
        ...actual.db.query,
        tasks: { findFirst: (...args: unknown[]) => mockFindTask(...args) },
      },
      update: () => mockDbUpdate(),
    },
    createComputeProviderMutationEventRecorder: vi.fn(() => mockRecordMutation),
  };
});

vi.mock('@roomote/compute-providers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/compute-providers')>();

  return {
    ...actual,
    createAzureMachine: (...args: unknown[]) => mockCreateAzureMachine(...args),
    createComputeProviderClient: (arg: unknown) =>
      mockCreateComputeProviderClient(arg),
    buildComputeProviderMutationDetails: vi.fn(
      (_context: unknown, details: Record<string, unknown> = {}) => details,
    ),
    buildAzureWorkerEnv: vi.fn(() => ({ AUTH_TOKEN: 'auth_token' })),
    cleanupAzureInstance: vi.fn(),
    resolveAuthBypassHeaderName: vi.fn(() => undefined),
    resolveAuthBypassValue: vi.fn(() => undefined),
  };
});

vi.mock('../../utils', () => ({
  getNamedPortsForTaskRun: (...args: unknown[]) =>
    mockGetNamedPortsForTaskRun(...args),
  shouldEnableAuthBypassForTaskRun: vi.fn(() => false),
  updateTaskRunMachine: (...args: unknown[]) =>
    mockUpdateTaskRunMachine(...args),
}));

vi.mock('../../sandbox-oidc', () => ({
  primeEnvironmentOidcForMachine: (...args: unknown[]) =>
    mockPrimeEnvironmentOidcForMachine(...args),
}));

const { spawnAzureWorker } = await import('../spawn-azure-worker');
const { cleanupAzureInstance } = await import('@roomote/compute-providers');

const config = {
  azureSubscriptionId: 'subscription',
  azureResourceGroup: 'resource-group',
  azureSandboxGroup: 'sandbox-group',
  azureRegion: 'eastus',
  azureDiskImage: 'roomote-worker-disk',
  azureTimeoutMs: 60_000,
};

describe('spawnAzureWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAzureMachine.mockResolvedValue({
      machineId: 'azure-machine-123',
      domain: vi.fn().mockReturnValue('azure.example.com'),
      proxyPorts: {},
    });
    mockRunCommand.mockResolvedValue({
      exitCode: null,
      commandId: 'cmd_123',
    });
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [],
      environmentSnapshotId: undefined,
      environmentConfig: undefined,
    });
    mockUpdateTaskRunMachine.mockResolvedValue(undefined);
    mockPrimeEnvironmentOidcForMachine.mockResolvedValue(undefined);
    mockFindTask.mockResolvedValue({ workflow: 'standard' });
  });

  it('launches a fresh worker and reports its detached command', async () => {
    const result = await spawnAzureWorker(
      {
        id: 123,
        taskId: 'task_123',
        vendor: 'azure',
        sourceSnapshotId: null,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo' },
      } as unknown as TaskRun,
      'auth_token',
      config,
    );

    expect(mockCreateAzureMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        azureDiskImage: 'roomote-worker-disk',
        launchMode: 'fresh',
      }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'azure-machine-123',
        cmd: 'worker',
        args: ['run', '123'],
        detached: true,
      }),
    );
    expect(result).toEqual({
      machineId: 'azure-machine-123',
      sandboxCmdId: 'cmd_123',
    });
  });

  it('carries the Credential egress bootstrap env and admits after the worker launches', async () => {
    const admit = vi.fn().mockResolvedValue({
      workloadId: 'w1',
      generation: 1,
      substitutes: [],
    });
    const planApiProxy = vi.fn().mockResolvedValue({
      required: true,
      bootstrapEnv: {
        ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_REQUIRED: '1',
        ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_NONCE: 'nonce-1',
      },
      admit,
    });
    const taskRun = {
      id: 123,
      taskId: 'task_123',
      vendor: 'azure',
      sourceSnapshotId: null,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: { repo: 'test/repo' },
    } as unknown as TaskRun;

    await spawnAzureWorker(taskRun, 'auth_token', {
      ...config,
      credentialEgress: { planApiProxy } as never,
    });

    expect(planApiProxy).toHaveBeenCalledWith({ taskRun, provider: 'azure' });
    expect(mockRunCommand.mock.calls.at(-1)![0].env).toMatchObject({
      ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_REQUIRED: '1',
      ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_NONCE: 'nonce-1',
    });
    // Admission runs only once the worker is launched and waiting.
    expect(admit).toHaveBeenCalledOnce();
    expect(admit.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mockRunCommand.mock.invocationCallOrder[0]!,
    );
  });

  it('cleans up the sandbox when Credential egress admission fails after launch', async () => {
    const planApiProxy = vi.fn().mockResolvedValue({
      required: true,
      bootstrapEnv: {
        ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_REQUIRED: '1',
        ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_NONCE: 'nonce-1',
      },
      admit: vi
        .fn()
        .mockRejectedValue(
          new Error('Credential egress bootstrap admission timed out'),
        ),
    });

    await expect(
      spawnAzureWorker(
        {
          id: 123,
          taskId: 'task_123',
          vendor: 'azure',
          sourceSnapshotId: null,
          payloadKind: TaskPayloadKind.StandardTask,
          payload: { repo: 'test/repo' },
        } as unknown as TaskRun,
        'auth_token',
        { ...config, credentialEgress: { planApiProxy } as never },
      ),
    ).rejects.toThrow('Credential egress bootstrap admission timed out');
    expect(cleanupAzureInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'azure-machine-123',
        phase: 'spawn_worker',
      }),
    );
  });
});

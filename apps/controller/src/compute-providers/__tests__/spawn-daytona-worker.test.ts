import type { TaskRun } from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

const mockCreateDaytonaMachine = vi.fn();
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
    createDaytonaMachine: (...args: unknown[]) =>
      mockCreateDaytonaMachine(...args),
    createComputeProviderClient: (arg: unknown) =>
      mockCreateComputeProviderClient(arg),
    buildComputeProviderMutationDetails: vi.fn(
      (_context: unknown, details: Record<string, unknown> = {}) => details,
    ),
    buildDaytonaWorkerEnv: vi.fn(() => ({ AUTH_TOKEN: 'auth_token' })),
    cleanupDaytonaInstance: vi.fn(),
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

const { spawnDaytonaWorker } = await import('../spawn-daytona-worker');
const { cleanupDaytonaInstance } = await import('@roomote/compute-providers');

describe('spawnDaytonaWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateDaytonaMachine.mockResolvedValue({
      machineId: 'daytona-machine-123',
      domain: vi.fn().mockReturnValue('daytona.example.com'),
      proxyPorts: {},
    });
    mockRunCommand.mockResolvedValue({
      exitCode: null,
      commandId: 'cmd_123',
    });
    mockUpdateTaskRunMachine.mockResolvedValue(undefined);
    mockPrimeEnvironmentOidcForMachine.mockResolvedValue(undefined);
    mockFindTask.mockResolvedValue({ workflow: 'standard' });
  });

  it('launches environments with docker projects', async () => {
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [{ name: 'SANDBOX_SERVER', port: 7777 }],
      environmentSnapshotId: undefined,
      environmentConfig: {
        docker_projects: [
          {
            name: 'app',
            type: 'compose',
            repository: 'test/repo',
            files: ['compose.yaml'],
          },
        ],
      },
    });

    const result = await spawnDaytonaWorker(
      {
        id: 123,
        taskId: 'task_123',
        vendor: 'daytona',
        sourceSnapshotId: null,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo', environmentId: 'env_123' },
      } as unknown as TaskRun,
      'auth_token',
      {
        deploymentSlug: 'roomote',
        daytonaApiKey: 'api-key',
        daytonaSnapshotName: 'worker-snapshot',
        daytonaTimeoutMs: 60_000,
      },
    );

    expect(mockCreateDaytonaMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        daytonaSnapshotName: 'worker-snapshot',
        launchMode: 'fresh',
      }),
    );
    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'daytona',
        config: expect.objectContaining({ memoryGiB: 8 }),
      }),
    );
    expect(mockUpdateTaskRunMachine).toHaveBeenCalledWith(
      expect.objectContaining({ configuredMemoryMiB: 8192 }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'daytona-machine-123',
        cmd: 'worker',
        args: ['run', '123'],
        detached: true,
      }),
    );
    expect(result).toEqual({
      machineId: 'daytona-machine-123',
      sandboxCmdId: 'cmd_123',
    });
  });

  it('uses 4 GiB for a task that does not need nested Docker', async () => {
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [],
      environmentSnapshotId: undefined,
      environmentConfig: undefined,
    });

    await spawnDaytonaWorker(
      {
        id: 124,
        taskId: 'task_124',
        vendor: 'daytona',
        sourceSnapshotId: null,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo' },
      } as unknown as TaskRun,
      'auth_token',
      {
        daytonaApiKey: 'api-key',
        daytonaSnapshotName: 'worker-snapshot',
        daytonaTimeoutMs: 60_000,
      },
    );

    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'daytona',
        config: expect.objectContaining({ memoryGiB: 4 }),
      }),
    );
  });

  it('carries the Credential egress bootstrap env and admits after the worker launches', async () => {
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [],
      environmentSnapshotId: undefined,
      environmentConfig: undefined,
    });
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
      vendor: 'daytona',
      sourceSnapshotId: null,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: { repo: 'test/repo' },
    } as unknown as TaskRun;

    await spawnDaytonaWorker(taskRun, 'auth_token', {
      daytonaApiKey: 'api-key',
      daytonaSnapshotName: 'worker-snapshot',
      daytonaTimeoutMs: 60_000,
      credentialEgress: { planApiProxy } as never,
    });

    expect(planApiProxy).toHaveBeenCalledWith({ taskRun, provider: 'daytona' });
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
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [],
      environmentSnapshotId: undefined,
      environmentConfig: undefined,
    });
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
      spawnDaytonaWorker(
        {
          id: 123,
          taskId: 'task_123',
          vendor: 'daytona',
          sourceSnapshotId: null,
          payloadKind: TaskPayloadKind.StandardTask,
          payload: { repo: 'test/repo' },
        } as unknown as TaskRun,
        'auth_token',
        {
          daytonaApiKey: 'api-key',
          daytonaSnapshotName: 'worker-snapshot',
          daytonaTimeoutMs: 60_000,
          credentialEgress: { planApiProxy } as never,
        },
      ),
    ).rejects.toThrow('Credential egress bootstrap admission timed out');
    expect(cleanupDaytonaInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'daytona-machine-123',
        phase: 'spawn_worker',
      }),
    );
  });
});

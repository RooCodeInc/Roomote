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

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    db: {
      ...actual.db,
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
  });

  it('launches environments with container projects', async () => {
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [{ name: 'SANDBOX_SERVER', port: 7777 }],
      environmentSnapshotId: undefined,
      environmentConfig: {
        container_projects: [
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
});

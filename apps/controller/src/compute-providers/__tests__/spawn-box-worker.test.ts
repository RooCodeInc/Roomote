import type { TaskRun } from '@roomote/db/server';
import { NonRetryableSpawnError, TaskPayloadKind } from '@roomote/types';

const mockCreateBoxMachine = vi.fn();
const mockRunCommand = vi.fn();
const mockDestroyInstance = vi.fn();
const mockEnterStandby = vi.fn();
const mockRecordMutation = vi.fn();
const mockUpdateTaskRunMachine = vi.fn();
const mockGetNamedPortsForTaskRun = vi.fn();
const mockStampTaskRunMilestone = vi.fn();
const mockPrimeEnvironmentOidcForMachine = vi.fn();
const mockCreateComputeProviderClient = vi.fn((_arg?: unknown) => ({
  runCommand: mockRunCommand,
  destroyInstance: mockDestroyInstance,
  enterStandby: mockEnterStandby,
}));
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
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    },
    createComputeProviderMutationEventRecorder: vi.fn(() => mockRecordMutation),
  };
});

vi.mock('@roomote/sdk/server', () => ({
  stampTaskRunMilestone: (...args: unknown[]) =>
    mockStampTaskRunMilestone(...args),
}));

vi.mock('@roomote/compute-providers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/compute-providers')>();
  return {
    ...actual,
    createBoxMachine: (...args: unknown[]) => mockCreateBoxMachine(...args),
    createComputeProviderClient: (arg: unknown) =>
      mockCreateComputeProviderClient(arg),
    buildBoxWorkerEnv: vi.fn(() => ({ AUTH_TOKEN: 'auth-token' })),
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

const { resolveBoxMachineType, spawnBoxWorker } =
  await import('../spawn-box-worker');

const config = {
  boxApiKey: 'key',
  boxApiBaseUrl: 'https://api.box.test',
  boxTimeoutMs: 5 * 60 * 60 * 1_000,
};

function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 321,
    taskId: 'task-321',
    vendor: 'box',
    payloadKind: TaskPayloadKind.StandardTask,
    sourceSnapshotId: null,
    payload: { environmentId: 'env-1' },
    ...overrides,
  } as TaskRun;
}

describe('spawnBoxWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [{ name: 'web', port: 3000, proxied: false }],
      environmentConfig: { ports: [{ name: 'web', port: 3000 }] },
    });
    mockCreateBoxMachine.mockResolvedValue({
      machineId: 'box-1',
      proxyPorts: { web: 30_000 },
      domain: vi.fn(() => 'https://private.box.test'),
    });
    mockRunCommand.mockResolvedValue({
      exitCode: null,
      commandId: 'worker-command-1',
    });
    mockDestroyInstance.mockResolvedValue({});
    mockEnterStandby.mockResolvedValue({ resumeHandle: 'box-standby' });
    mockFindTask.mockResolvedValue({ workflow: 'standard' });
  });

  it('creates and routes a fresh Box worker with OIDC priming', async () => {
    await spawnBoxWorker(taskRun(), 'auth-token', config);

    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith({
      provider: 'box',
      config: {
        apiKey: 'key',
        boxApiBaseUrl: 'https://api.box.test',
        machineType: 'small',
        timeoutMs: config.boxTimeoutMs,
      },
    });
    expect(mockCreateBoxMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        launchMode: 'fresh',
        machineType: 'small',
        namedPorts: [{ name: 'web', port: 3000, proxied: false }],
      }),
    );
    expect(mockUpdateTaskRunMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: 'box',
        machineId: 'box-1',
        configuredMemoryMiB: 4096,
        explicitPrimaryPortName: 'web',
      }),
    );
    expect(mockPrimeEnvironmentOidcForMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        computeProvider: 'box',
        computeProviderId: 'box-1',
        context: 'Fresh Box launch',
      }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'box-1',
        cmd: 'worker',
        args: ['run', '321'],
        detached: true,
      }),
    );
  });

  it('resumes a retained Box worker without treating it as a snapshot', async () => {
    mockCreateBoxMachine.mockResolvedValue({
      machineId: 'box-standby',
      sourceSnapshotId: 'box-standby',
      proxyPorts: {},
      domain: vi.fn(),
    });

    await spawnBoxWorker(
      taskRun({
        payloadKind: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: 'box-standby',
      }),
      'auth-token',
      config,
    );

    expect(mockCreateBoxMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        launchMode: 'task_standby',
        resumeHandle: 'box-standby',
      }),
    );
    expect(mockUpdateTaskRunMachine).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSnapshotId: 'box-standby' }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['resume', '321'] }),
    );
  });

  it('selects the smallest machine satisfying task and configured memory', () => {
    expect(resolveBoxMachineType(4096)).toBe('small');
    expect(resolveBoxMachineType(8192)).toBe('default');
    expect(resolveBoxMachineType(4096, 'large')).toBe('large');
    expect(() => resolveBoxMachineType(16_385)).toThrow(NonRetryableSpawnError);
  });

  it('runs environment snapshot jobs fresh with the worker snapshot command', async () => {
    await spawnBoxWorker(
      taskRun({ payloadKind: TaskPayloadKind.SnapshotEnvironment }),
      'auth-token',
      config,
    );

    expect(mockCreateBoxMachine).toHaveBeenCalledWith(
      expect.objectContaining({ launchMode: 'fresh' }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          'snapshot',
          '--task-run-id',
          '321',
          '--environment-id',
          'env-1',
          '--sandbox-id',
          'box-1',
        ],
      }),
    );
  });

  it('forks the environment template for standard runs with a snapshot', async () => {
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [{ name: 'web', port: 3000, proxied: false }],
      environmentConfig: { ports: [{ name: 'web', port: 3000 }] },
      environmentSnapshotId: 'roomote-snap-env1',
    });

    await spawnBoxWorker(taskRun(), 'auth-token', config);

    expect(mockCreateBoxMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        launchMode: 'environment_snapshot',
        sourceSnapshotId: 'roomote-snap-env1',
      }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['run', '321'] }),
    );
  });

  it('forks a template on resume when the id is a named snapshot', async () => {
    await spawnBoxWorker(
      taskRun({
        payloadKind: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: 'roomote-snap-task9',
      }),
      'auth-token',
      config,
    );

    expect(mockCreateBoxMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        launchMode: 'task_snapshot',
        sourceSnapshotId: 'roomote-snap-task9',
      }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['resume', '321'] }),
    );
  });

  it('re-archives a resumed Box when launching its worker fails', async () => {
    mockCreateBoxMachine.mockResolvedValue({
      machineId: 'box-standby',
      sourceSnapshotId: 'box-standby',
      proxyPorts: {},
      domain: vi.fn(),
    });
    mockRunCommand.mockResolvedValue({
      exitCode: 17,
      commandId: 'worker-command-failed',
      stderr: 'worker failed',
    });

    await expect(
      spawnBoxWorker(
        taskRun({
          payloadKind: TaskPayloadKind.SnapshotResume,
          sourceSnapshotId: 'box-standby',
        }),
        'auth-token',
        config,
      ),
    ).rejects.toThrow('Detached Box worker exited with code 17');

    expect(mockEnterStandby).toHaveBeenCalledWith({
      instanceId: 'box-standby',
      commandId: 'worker-command-failed',
    });
    expect(mockDestroyInstance).not.toHaveBeenCalled();
  });

  it('does not expose detached worker output in launch errors', async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 17,
      stdout: 'AUTH_TOKEN=stdout-secret',
      stderr: 'AUTH_TOKEN=stderr-secret',
    });

    const error = await spawnBoxWorker(taskRun(), 'auth-token', config).catch(
      (value) => value,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Detached Box worker exited with code 17');
    expect(error.message).not.toContain('stdout-secret');
    expect(error.message).not.toContain('stderr-secret');
    expect(mockDestroyInstance).toHaveBeenCalledWith({ instanceId: 'box-1' });
  });
});

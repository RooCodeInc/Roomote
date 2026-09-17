import type { TaskRun } from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

const mockCreateBlaxelMachine = vi.fn();
const mockRunCommand = vi.fn();
const mockDestroyInstance = vi.fn();
const mockEnterStandby = vi.fn();
const mockRecordMutation = vi.fn();
const mockUpdateTaskRunMachine = vi.fn();
const mockGetNamedPortsForTaskRun = vi.fn();
const mockStampTaskRunMilestone = vi.fn();
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
    createBlaxelMachine: (...args: unknown[]) =>
      mockCreateBlaxelMachine(...args),
    createComputeProviderClient: (arg: unknown) =>
      mockCreateComputeProviderClient(arg),
    buildBlaxelWorkerEnv: vi.fn(() => ({ AUTH_TOKEN: 'auth-token' })),
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
  primeEnvironmentOidcForMachine: vi.fn(),
}));

const { spawnBlaxelWorker } = await import('../spawn-blaxel-worker');

describe('spawnBlaxelWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [],
      environmentSnapshotId: undefined,
      environmentConfig: undefined,
    });
    mockCreateBlaxelMachine.mockResolvedValue({
      machineId: 'roomote-blaxel-standby',
      sourceSnapshotId: 'roomote-blaxel-standby',
      proxyPorts: {},
      domain: vi.fn(),
    });
    mockRunCommand.mockResolvedValue({
      exitCode: null,
      commandId: 'worker-command-2',
    });
    mockEnterStandby.mockResolvedValue({
      resumeHandle: 'roomote-blaxel-standby',
    });
    mockFindTask.mockResolvedValue({ workflow: 'standard' });
  });

  it('reconnects SnapshotResume runs using task standby mode', async () => {
    await spawnBlaxelWorker(
      {
        id: 321,
        taskId: 'task-321',
        vendor: 'blaxel',
        payloadKind: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: 'roomote-blaxel-standby',
        payload: { repo: 'test/repo' },
      } as TaskRun,
      'auth-token',
      {
        blaxelApiKey: 'key',
        blaxelWorkspace: 'workspace',
        blaxelImage: 'sandbox/roomote-worker:test',
        blaxelTimeoutMs: 5 * 60 * 60 * 1_000,
      },
    );

    expect(mockCreateBlaxelMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'roomote-task-task-321',
        launchMode: 'task_standby',
        resumeHandle: 'roomote-blaxel-standby',
      }),
    );
    expect(mockStampTaskRunMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 321,
        launchMode: 'task_standby',
      }),
    );
    expect(mockUpdateTaskRunMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'roomote-blaxel-standby',
        sourceSnapshotId: 'roomote-blaxel-standby',
      }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'roomote-blaxel-standby',
        cmd: 'worker',
        args: ['resume', '321'],
        detached: true,
      }),
    );
    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'blaxel',
        config: expect.objectContaining({ memoryMiB: 4096 }),
      }),
    );
  });

  it('uses 8 GiB for setup tasks before an environment config exists', async () => {
    mockFindTask.mockResolvedValue({ workflow: 'setup_onboarding' });

    await spawnBlaxelWorker(
      {
        id: 323,
        taskId: 'task-323',
        vendor: 'blaxel',
        payloadKind: TaskPayloadKind.StandardTask,
        sourceSnapshotId: null,
        payload: { repo: 'test/repo' },
      } as TaskRun,
      'auth-token',
      {
        blaxelApiKey: 'key',
        blaxelWorkspace: 'workspace',
        blaxelImage: 'sandbox/roomote-worker:test',
        blaxelTimeoutMs: 5 * 60 * 60 * 1_000,
      },
    );

    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'blaxel',
        config: expect.objectContaining({ memoryMiB: 8192 }),
      }),
    );
  });

  it('preserves the standby sandbox when launching the resumed worker fails', async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 17,
      commandId: 'worker-command-failed',
      stderr: 'worker failed',
    });

    await expect(
      spawnBlaxelWorker(
        {
          id: 322,
          taskId: 'task-322',
          vendor: 'blaxel',
          payloadKind: TaskPayloadKind.SnapshotResume,
          sourceSnapshotId: 'roomote-blaxel-standby',
          payload: { repo: 'test/repo' },
        } as TaskRun,
        'auth-token',
        {
          blaxelApiKey: 'key',
          blaxelWorkspace: 'workspace',
          blaxelImage: 'sandbox/roomote-worker:test',
          blaxelTimeoutMs: 5 * 60 * 60 * 1_000,
        },
      ),
    ).rejects.toThrow('Detached Blaxel worker exited with code 17');

    expect(mockEnterStandby).toHaveBeenCalledWith({
      instanceId: 'roomote-blaxel-standby',
      commandId: 'worker-command-failed',
    });
    expect(mockDestroyInstance).not.toHaveBeenCalled();
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
      id: 321,
      taskId: 'task-321',
      vendor: 'blaxel',
      payloadKind: TaskPayloadKind.StandardTask,
      sourceSnapshotId: null,
      payload: { repo: 'test/repo' },
    } as TaskRun;

    await spawnBlaxelWorker(taskRun, 'auth-token', {
      blaxelApiKey: 'key',
      blaxelWorkspace: 'workspace',
      blaxelImage: 'sandbox/roomote-worker:test',
      blaxelTimeoutMs: 5 * 60 * 60 * 1_000,
      credentialEgress: { planApiProxy } as never,
    });

    expect(planApiProxy).toHaveBeenCalledWith({ taskRun, provider: 'blaxel' });
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

  it('restores standby when Credential egress admission fails after a resumed launch', async () => {
    const admit = vi.fn().mockRejectedValue(new Error('admission failed'));

    await expect(
      spawnBlaxelWorker(
        {
          id: 322,
          taskId: 'task-322',
          vendor: 'blaxel',
          payloadKind: TaskPayloadKind.SnapshotResume,
          sourceSnapshotId: 'roomote-blaxel-standby',
          payload: { repo: 'test/repo' },
        } as TaskRun,
        'auth-token',
        {
          blaxelApiKey: 'key',
          blaxelWorkspace: 'workspace',
          blaxelImage: 'sandbox/roomote-worker:test',
          blaxelTimeoutMs: 5 * 60 * 60 * 1_000,
          credentialEgress: {
            planApiProxy: vi.fn().mockResolvedValue({
              required: true,
              bootstrapEnv: {},
              admit,
            }),
          } as never,
        },
      ),
    ).rejects.toThrow('admission failed');
    expect(mockEnterStandby).toHaveBeenCalledWith({
      instanceId: 'roomote-blaxel-standby',
      commandId: 'worker-command-2',
    });
    expect(mockDestroyInstance).not.toHaveBeenCalled();
  });
});

import type { Mock } from 'vitest';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

// Hoist ALL mock functions so they're available inside vi.mock factories.
const {
  mockCreateComputeProviderClient,
  mockGetComputeProviderCapabilities,
  mockDestroyInstance,
  mockGetInstanceStatus,
  mockCreateSnapshot,
  mockFinishCloudJob,
  mockRecordComputeProviderUsage,
  mockRecordMutation,
  mockCreateComputeProviderMutationEventRecorder,
  mockRecordCloudJobEvent,
  mockMarkTaskStartParallelCountEndedAt,
  mockDbQueryTaskRunsFindFirst,
  captureBullMqMessageMock,
  transactionFn,
  eqFn,
  gtFn,
  ascFn,
  descFn,
  orFn,
  returningFn,
  updateWhereFn,
  setFn,
  updateFn,
  selectLimitFn,
  selectOrderByFn,
  selectWhereFn,
  fromFn,
  selectFn,
  inArrayFn,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyMock = Mock<(...args: any[]) => any>;

  const returningFn: AnyMock = vi.fn(() => Promise.resolve([]));
  const updateWhereFn: AnyMock = vi.fn(() => {
    const result = Promise.resolve([]);
    // Support both .returning() (optimistic lock) and .catch() (rollback) call patterns.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any).returning = returningFn;
    return result;
  });
  const setFn: AnyMock = vi.fn(() => ({ where: updateWhereFn }));
  const updateFn: AnyMock = vi.fn(() => ({ set: setFn }));
  const selectLimitFn: AnyMock = vi.fn(() => Promise.resolve([]));
  const selectOrderByFn: AnyMock = vi.fn(() => ({ limit: selectLimitFn }));
  const selectWhereFn: AnyMock = vi.fn(() => ({ orderBy: selectOrderByFn }));
  const fromFn: AnyMock = vi.fn(() => ({ where: selectWhereFn }));
  const selectFn: AnyMock = vi.fn(() => ({ from: fromFn }));
  const ascFn: AnyMock = vi.fn((column) => ({
    column,
    direction: 'asc',
  }));
  const descFn: AnyMock = vi.fn((column) => ({
    column,
    direction: 'desc',
  }));
  const inArrayFn: AnyMock = vi.fn();
  const eqFn: AnyMock = vi.fn();
  const gtFn: AnyMock = vi.fn();
  const orFn: AnyMock = vi.fn();

  return {
    mockCreateComputeProviderClient: vi.fn() as AnyMock,
    mockGetComputeProviderCapabilities: vi.fn() as AnyMock,
    mockDestroyInstance: vi.fn() as AnyMock,
    mockGetInstanceStatus: vi.fn() as AnyMock,
    mockCreateSnapshot: vi.fn() as AnyMock,
    mockFinishCloudJob: vi.fn() as AnyMock,
    mockRecordComputeProviderUsage: vi.fn() as AnyMock,
    mockRecordMutation: vi.fn() as AnyMock,
    mockCreateComputeProviderMutationEventRecorder: vi.fn() as AnyMock,
    mockRecordCloudJobEvent: vi.fn() as AnyMock,
    mockMarkTaskStartParallelCountEndedAt: vi.fn() as AnyMock,
    mockDbQueryTaskRunsFindFirst: vi.fn() as AnyMock,
    captureBullMqMessageMock: vi.fn() as AnyMock,
    transactionFn: vi.fn() as AnyMock,
    eqFn,
    gtFn,
    ascFn,
    descFn,
    orFn,
    returningFn,
    updateWhereFn,
    setFn,
    updateFn,
    selectLimitFn,
    selectOrderByFn,
    selectWhereFn,
    fromFn,
    selectFn,
    inArrayFn,
  };
});

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: mockCreateComputeProviderClient,
  getComputeProviderCapabilities: (
    ...args: Parameters<typeof mockGetComputeProviderCapabilities>
  ) =>
    mockGetComputeProviderCapabilities(...args) ?? {
      supportsSnapshots: true,
    },
}));

vi.mock('@roomote/sdk/server', () => ({
  createSnapshot: mockCreateSnapshot,
  finishCloudJob: mockFinishCloudJob,
  recordComputeProviderUsage: mockRecordComputeProviderUsage,
}));

vi.mock('../../monitoring/sentry', () => ({
  captureBullMqMessage: captureBullMqMessageMock,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: selectFn,
    transaction: transactionFn,
    update: updateFn,
    query: {
      taskRuns: {
        findFirst: mockDbQueryTaskRunsFindFirst,
      },
    },
  },
  taskRuns: {
    machineId: 'machineId',
    createdAt: 'createdAt',
    startedAt: 'startedAt',
    sleepAt: 'sleepAt',
    taskPhase: 'taskPhase',
    sleepRequestedAt: 'sleepRequestedAt',
    workerHeartbeatAt: 'workerHeartbeatAt',
    payloadKind: 'payloadKind',
    status: 'status',
    snapshotId: 'snapshotId',
    snapshotRequestedAt: 'snapshotRequestedAt',
    vendor: 'vendor',
    id: 'id',
    taskId: 'taskId',
  },
  eq: eqFn,
  and: vi.fn(),
  or: orFn,
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  inArray: inArrayFn,
  gt: gtFn,
  lte: vi.fn(),
  asc: ascFn,
  desc: descFn,
  createComputeProviderMutationEventRecorder:
    mockCreateComputeProviderMutationEventRecorder,
  markTaskStartParallelCountEndedAt: mockMarkTaskStartParallelCountEndedAt,
  recordCloudJobEvent: mockRecordCloudJobEvent,
  resolveComputeProviderEnvValues: vi.fn().mockResolvedValue({}),
}));

// Import after mocks are set up.
import { sleepCheckJob } from '../sleep-check';

/**
 * Mock the sequential DB select queries in sleepCheckJob.
 * Order matters: the first resolved value maps to the dueJobs query,
 * the second to the staleWorkerJobs query, the third to the booting jobs
 * that never emitted a heartbeat, and the fourth to the provider
 * hard-timeout backstop query.
 */
function mockJobQueries({
  dueJobs = [],
  staleJobs = [],
  bootingJobs = [],
  hardLimitJobs = [],
}: {
  dueJobs?: unknown[];
  staleJobs?: unknown[];
  bootingJobs?: unknown[];
  hardLimitJobs?: unknown[];
}) {
  const normalizedDueJobs = dueJobs.map((job) =>
    job && typeof job === 'object' && !('sleepAt' in job) && !Array.isArray(job)
      ? { ...job, sleepAt: new Date(Date.now() - 1_000) }
      : job,
  );
  const normalizedHardLimitJobs = hardLimitJobs.map((job) =>
    job && typeof job === 'object' && !('sleepAt' in job) && !Array.isArray(job)
      ? { ...job, sleepAt: new Date(Date.now() + 30 * 60 * 1_000) }
      : job,
  );

  selectLimitFn
    .mockResolvedValueOnce(normalizedDueJobs)
    .mockResolvedValueOnce(staleJobs)
    .mockResolvedValueOnce(bootingJobs)
    .mockResolvedValueOnce(normalizedHardLimitJobs);
}

describe('sleepCheckJob', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset default mock implementations.
    selectFn.mockReturnValue({ from: fromFn });
    fromFn.mockReturnValue({ where: selectWhereFn });
    selectWhereFn.mockReturnValue({ orderBy: selectOrderByFn });
    selectOrderByFn.mockReturnValue({ limit: selectLimitFn });
    selectLimitFn.mockResolvedValue([]);
    transactionFn.mockImplementation(async (callback) =>
      callback({
        update: updateFn,
      }),
    );
    mockMarkTaskStartParallelCountEndedAt.mockResolvedValue(undefined);
    mockCreateComputeProviderClient.mockImplementation(() => ({
      destroyInstance: mockDestroyInstance,
      getInstanceStatus: mockGetInstanceStatus,
    }));
    mockDestroyInstance.mockResolvedValue({});
    mockGetComputeProviderCapabilities.mockImplementation(() => ({
      supportsSnapshots: true,
    }));
    updateFn.mockReturnValue({ set: setFn });
    setFn.mockReturnValue({ where: updateWhereFn });
    mockCreateComputeProviderMutationEventRecorder.mockReturnValue(
      mockRecordMutation,
    );
    updateWhereFn.mockImplementation(() => {
      const result = Promise.resolve([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any).returning = returningFn;
      return result;
    });
    returningFn.mockResolvedValue([]);
    mockFinishCloudJob.mockResolvedValue(undefined);
    // No stop request persisted on the row unless a test opts in.
    mockDbQueryTaskRunsFindFirst.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('does nothing when no due jobs are returned', async () => {
    mockJobQueries({});

    await sleepCheckJob();

    expect(mockGetInstanceStatus).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockDestroyInstance).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('caps each candidate query to a bounded batch', async () => {
    mockJobQueries({});

    await sleepCheckJob();

    expect(selectLimitFn).toHaveBeenCalledTimes(4);
    expect(selectLimitFn).toHaveBeenNthCalledWith(1, 500);
    expect(selectLimitFn).toHaveBeenNthCalledWith(2, 500);
    expect(selectLimitFn).toHaveBeenNthCalledWith(3, 500);
    expect(selectLimitFn).toHaveBeenNthCalledWith(4, 500);
  });

  it('orders bounded due and stale scans by the oldest actionable timestamp', async () => {
    mockJobQueries({});

    await sleepCheckJob();

    expect(selectOrderByFn).toHaveBeenNthCalledWith(
      1,
      { column: 'sleepAt', direction: 'asc' },
      { column: 'createdAt', direction: 'asc' },
    );
    expect(selectOrderByFn).toHaveBeenNthCalledWith(
      2,
      { column: 'workerHeartbeatAt', direction: 'asc' },
      { column: 'createdAt', direction: 'asc' },
    );
    expect(selectOrderByFn).toHaveBeenNthCalledWith(
      3,
      { column: 'startedAt', direction: 'asc' },
      { column: 'createdAt', direction: 'asc' },
    );
    expect(selectOrderByFn).toHaveBeenNthCalledWith(4, {
      column: 'createdAt',
      direction: 'desc',
    });
  });

  it('uses inArray for stale-worker query so idle jobs are recovered too', async () => {
    mockJobQueries({});

    await sleepCheckJob();

    // dueJobs query uses inArray with two statuses
    expect(inArrayFn).toHaveBeenCalledWith('status', [
      RunStatus.Running,
      RunStatus.Idle,
    ]);
    // staleWorkerJobs query also uses inArray so idle jobs are recovered.
    expect(inArrayFn).toHaveBeenCalledWith('status', [
      RunStatus.Running,
      RunStatus.Idle,
    ]);
    expect(inArrayFn).toHaveBeenCalledWith('status', [
      RunStatus.Processing,
      RunStatus.Preparing,
      RunStatus.Spawning,
      RunStatus.Connecting,
    ]);
  });

  it('completes idle due jobs whose instances are not running and records an event', async () => {
    mockJobQueries({
      dueJobs: [
        {
          id: 42,
          machineId: 'sb-1',
          payloadKind: TaskPayloadKind.StandardTask,
          status: RunStatus.Idle,
          vendor: 'modal',
          snapshotId: null,
          sleepRequestedAt: null,
          snapshotRequestedAt: null,
        },
      ],
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });
    returningFn.mockResolvedValue([{ id: 42 }]);

    await sleepCheckJob();

    expect(mockGetInstanceStatus).toHaveBeenCalledWith({
      instanceId: 'sb-1',
    });
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockDestroyInstance).not.toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith({
      sleepRequestedAt: expect.any(Date),
      snapshotFailedAt: expect.any(Date),
    });
    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 42,
      status: RunStatus.Completed,
      error: 'Auto-snapshot could not run because instance sb-1 was stopped.',
    });
    expect(mockRecordCloudJobEvent).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips idle completion when another process already claimed the row', async () => {
    mockJobQueries({
      dueJobs: [
        {
          id: 42,
          machineId: 'sb-1',
          payloadKind: TaskPayloadKind.StandardTask,
          status: RunStatus.Idle,
          vendor: 'modal',
          snapshotId: null,
          sleepRequestedAt: null,
          snapshotRequestedAt: null,
        },
      ],
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });
    returningFn.mockResolvedValue([]);

    await sleepCheckJob();

    expect(mockFinishCloudJob).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 42,
        eventType: 'decision',
        source: 'sleep_check',
      }),
    );
  });

  it('snapshots due resumable jobs', async () => {
    const mockJob = {
      id: 6622,
      machineId: 'sb-resume',
      payloadKind: TaskPayloadKind.SlackAppMention,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 60 * 1_000,
    });
    returningFn.mockResolvedValue([{ id: 6622 }]);
    mockCreateSnapshot.mockResolvedValue(true);

    await sleepCheckJob();

    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 6622,
        sandboxId: 'sb-resume',
        snapshotIntentId: expect.stringMatching(/^due_sleep-6622-/),
        triggerPath: 'due_sleep',
      }),
    );
    expect(setFn).toHaveBeenNthCalledWith(1, {
      sleepRequestedAt: expect.any(Date),
      snapshotRequestedAt: expect.any(Date),
    });
  });

  it('snapshots resumable jobs near the provider hard timeout even when sleepAt is still in the future', async () => {
    const mockJob = {
      id: 6624,
      machineId: 'sb-hard-limit',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: new Date(Date.now() + 30 * 60 * 1_000),
    };

    mockJobQueries({ hardLimitJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 1_000,
    });
    returningFn.mockResolvedValue([{ id: 6624 }]);
    mockCreateSnapshot.mockResolvedValue(true);

    await sleepCheckJob();

    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 6624,
        sandboxId: 'sb-hard-limit',
        snapshotIntentId: expect.stringMatching(/^hard_limit-6624-/),
        triggerPath: 'hard_limit',
      }),
    );
    expect(setFn).toHaveBeenNthCalledWith(1, {
      sleepRequestedAt: expect.any(Date),
      snapshotRequestedAt: expect.any(Date),
    });
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 6624,
        source: 'sleep_check',
        details: expect.objectContaining({
          path: 'hard_limit',
        }),
      }),
    );
  });

  it('also snapshots SnapshotResume jobs', async () => {
    const mockJob = {
      id: 6623,
      machineId: 'sb-snapshot-resume',
      payloadKind: TaskPayloadKind.SnapshotResume,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 60 * 1_000,
    });
    returningFn.mockResolvedValue([{ id: 6623 }]);
    mockCreateSnapshot.mockResolvedValue(true);

    await sleepCheckJob();

    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 6623,
        sandboxId: 'sb-snapshot-resume',
        snapshotIntentId: expect.stringMatching(/^due_sleep-6623-/),
        triggerPath: 'due_sleep',
      }),
    );
  });

  it('uses the modal client for modal-backed resumable jobs', async () => {
    const mockJob = {
      id: 6625,
      machineId: 'modal-resume',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 60 * 1_000,
    });
    returningFn.mockResolvedValue([{ id: 6625 }]);
    mockCreateSnapshot.mockResolvedValue(true);

    await sleepCheckJob();

    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith({
      provider: 'modal',
      envFallback: {},
    });
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 6625,
        sandboxId: 'modal-resume',
        snapshotIntentId: expect.stringMatching(/^due_sleep-6625-/),
        triggerPath: 'due_sleep',
      }),
    );
  });

  it('shuts down due non-resumable jobs', async () => {
    const mockJob = {
      id: 99,
      machineId: 'sb-2',
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 60 * 1_000,
    });
    mockDestroyInstance.mockResolvedValue({
      usageObservation: {
        activeCpuDurationMs: 8_765,
        networkTransfer: {
          ingress: 120,
          egress: 340,
        },
      },
    });
    returningFn.mockResolvedValue([{ id: 99 }]);

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockDestroyInstance).toHaveBeenCalledWith({ instanceId: 'sb-2' });
    expect(setFn).toHaveBeenNthCalledWith(1, {
      sleepRequestedAt: expect.any(Date),
    });
    expect(setFn).toHaveBeenNthCalledWith(2, {
      sleepAt: null,
      taskPhase: null,
      status: RunStatus.Completed,
      completedAt: expect.any(Date),
    });
    expect(mockRecordComputeProviderUsage).toHaveBeenCalledWith({
      cloudJobId: 99,
      lifecycleAction: 'destroy',
      completedAt: expect.any(Date),
      activeCpuDurationMs: 8_765,
      networkIngressBytes: 120,
      networkEgressBytes: 340,
      details: expect.objectContaining({
        provider: 'modal',
        path: 'due_sleep',
      }),
    });
    expect(captureBullMqMessageMock).not.toHaveBeenCalled();
  });

  it('reports provider-timeout backstop shutdowns to Sentry', async () => {
    const mockJob = {
      id: 100,
      machineId: 'sb-hard-limit-destroy',
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: new Date(Date.now() + 30 * 60 * 1_000),
    };

    mockJobQueries({ hardLimitJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 1_000,
    });
    mockDestroyInstance.mockResolvedValue({});
    returningFn.mockResolvedValue([{ id: 100 }]);

    await sleepCheckJob();

    expect(mockDestroyInstance).toHaveBeenCalledWith({
      instanceId: 'sb-hard-limit-destroy',
    });
    expect(captureBullMqMessageMock).toHaveBeenCalledWith(
      'Sleep check is destroying sandbox after provider timeout backstop.',
      expect.objectContaining({
        cloudJobId: 100,
        sandboxId: 'sb-hard-limit-destroy',
        taskPhase: 'waiting_for_prompt',
        triggerPath: 'hard_limit',
        rootCauseSummary: 'provider_timeout_backstop',
      }),
      expect.objectContaining({
        component: 'sleep-check',
        signal: 'sandbox-destroy',
      }),
    );
  });

  it('skips job when optimistic lock fails', async () => {
    const mockJob = {
      id: 77,
      machineId: 'sb-rollback',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 60 * 1_000,
    });
    returningFn.mockResolvedValue([]);

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockDestroyInstance).not.toHaveBeenCalled();
  });

  it('rolls back sleepRequestedAt and snapshotRequestedAt when snapshotting fails', async () => {
    const mockJob = {
      id: 77,
      machineId: 'sb-rollback',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 60 * 1_000,
    });
    returningFn.mockResolvedValue([{ id: 77 }]);
    mockCreateSnapshot.mockRejectedValue(new Error('Redis down'));

    await sleepCheckJob();

    // claimAndSnapshot: optimistic lock claim + internal rollback = 2 db.update calls.
    expect(updateFn).toHaveBeenCalledTimes(2);
    expect(setFn).toHaveBeenCalledTimes(2);
    expect(setFn).toHaveBeenLastCalledWith({
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    });
  });

  it('continues processing other jobs when one fails', async () => {
    const jobs = [
      {
        id: 10,
        machineId: 'sb-3',
        payloadKind: TaskPayloadKind.StandardTask,
        status: RunStatus.Running,
        taskPhase: 'waiting_for_prompt',
        vendor: 'modal',
        snapshotId: null,
        sleepRequestedAt: null,
        snapshotRequestedAt: null,
      },
      {
        id: 11,
        machineId: 'sb-4',
        payloadKind: TaskPayloadKind.StandardTask,
        status: RunStatus.Running,
        taskPhase: 'waiting_for_prompt',
        vendor: 'modal',
        snapshotId: null,
        sleepRequestedAt: null,
        snapshotRequestedAt: null,
      },
    ];

    mockJobQueries({ dueJobs: jobs });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 60 * 1_000,
    });

    // Both locks succeed.
    returningFn.mockResolvedValueOnce([{ id: 10 }]);
    returningFn.mockResolvedValueOnce([{ id: 11 }]);

    // First snapshot fails, second succeeds.
    mockCreateSnapshot.mockRejectedValueOnce(new Error('snapshot failed'));
    mockCreateSnapshot.mockResolvedValueOnce(true);

    // Should not throw.
    await sleepCheckJob();

    expect(mockCreateSnapshot).toHaveBeenCalledTimes(2);
  });

  it('extends stale active deadlines instead of snapshotting running jobs with plenty of sandbox time left', async () => {
    const mockJob = {
      id: 85,
      machineId: 'sb-stale-running',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    returningFn.mockResolvedValueOnce([{ id: 85 }]);

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockDestroyInstance).not.toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith({
      sleepAt: expect.any(Date),
    });
  });

  it('extends stale active deadlines for waiting_for_user_input jobs too', async () => {
    const mockJob = {
      id: 87,
      machineId: 'sb-stale-waiting',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_user_input',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    returningFn.mockResolvedValueOnce([{ id: 87 }]);

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockDestroyInstance).not.toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith({
      sleepAt: expect.any(Date),
    });
  });

  it('does not extend stale active deadlines after the row leaves running state', async () => {
    const mockJob = {
      id: 86,
      machineId: 'sb-stale-race',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
    };

    mockJobQueries({ dueJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    returningFn.mockResolvedValueOnce([]);

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockDestroyInstance).not.toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith({
      sleepAt: expect.any(Date),
    });
    expect(returningFn).toHaveBeenCalledWith({ id: 'id' });
  });

  it('snapshots booting resumable jobs when the initial worker heartbeat never arrives', async () => {
    const mockJob = {
      id: 89,
      machineId: 'sb-missing-first-heartbeat',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Processing,
      taskPhase: null,
      vendor: 'modal',
      startedAt: new Date(Date.now() - 5 * 60 * 1_000),
      workerHeartbeatAt: null,
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ bootingJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    returningFn.mockResolvedValueOnce([{ id: 89 }]);
    mockCreateSnapshot.mockResolvedValue(true);

    await sleepCheckJob();

    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 89,
        sandboxId: 'sb-missing-first-heartbeat',
        snapshotIntentId: expect.stringMatching(/^booting_no_heartbeat-89-/),
        triggerPath: 'booting_no_heartbeat',
      }),
    );
    expect(mockFinishCloudJob).not.toHaveBeenCalled();
  });

  it('snapshots stale resumable jobs whose worker heartbeat stopped updating', async () => {
    const staleWorkerAt = new Date(Date.now() - 5 * 60 * 1_000);
    const mockJob = {
      id: 90,
      machineId: 'sb-stale-worker',
      payloadKind: TaskPayloadKind.SlackAppMention,
      status: RunStatus.Running,
      taskPhase: 'stopped',
      vendor: 'modal',
      workerHeartbeatAt: staleWorkerAt,
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ staleJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    returningFn.mockResolvedValueOnce([{ id: 90 }]);
    mockCreateSnapshot.mockResolvedValue(true);

    await sleepCheckJob();

    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 90,
        sandboxId: 'sb-stale-worker',
        snapshotIntentId: expect.stringMatching(/^stale_worker-90-/),
        triggerPath: 'stale_worker',
      }),
    );
    expect(mockFinishCloudJob).not.toHaveBeenCalled();
  });

  it('fails booting jobs when the initial heartbeat never arrives and the sandbox is already gone', async () => {
    const mockJob = {
      id: 95,
      machineId: 'sb-booting-gone',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Processing,
      taskPhase: null,
      vendor: 'modal',
      startedAt: new Date(Date.now() - 5 * 60 * 1_000),
      workerHeartbeatAt: null,
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ bootingJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 95,
      status: RunStatus.Failed,
      error:
        'Initial worker heartbeat missing and instance sb-booting-gone is stopped',
    });
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 95,
        eventType: 'started',
        source: 'sleep_check',
        details: expect.objectContaining({
          preferredPath: 'booting_no_heartbeat',
          bootingNoHeartbeatCloudJobId: 95,
        }),
      }),
    );
  });

  it('prioritizes the hard-limit snapshot path over stale-worker recovery when the sandbox is near reap', async () => {
    const mockJob = {
      id: 93,
      machineId: 'sb-hard-limit-wins',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      workerHeartbeatAt: new Date(Date.now() - 5 * 60 * 1_000),
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: new Date(Date.now() + 30 * 60 * 1_000),
    };

    mockJobQueries({ staleJobs: [mockJob], hardLimitJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 5 * 60 * 1_000,
    });
    returningFn.mockResolvedValueOnce([{ id: 93 }]);
    mockCreateSnapshot.mockResolvedValue(true);

    await sleepCheckJob();

    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 93,
        sandboxId: 'sb-hard-limit-wins',
        snapshotIntentId: expect.stringMatching(/^hard_limit-93-/),
        triggerPath: 'hard_limit',
      }),
    );

    const recordedPaths = mockRecordCloudJobEvent.mock.calls
      .map(([, input]) => input.details?.path)
      .filter(Boolean);

    expect(recordedPaths).toContain('hard_limit');
    expect(recordedPaths).not.toContain('stale_worker');
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 93,
        eventType: 'started',
        source: 'sleep_check',
        details: expect.objectContaining({
          preferredPath: 'hard_limit',
          hardLimitCloudJobId: 93,
          staleWorkerCloudJobId: 93,
        }),
      }),
    );
  });

  it('falls back to stale-worker recovery when a stale worker is not near the provider hard limit', async () => {
    const mockJob = {
      id: 94,
      machineId: 'sb-stale-worker-fallback',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      workerHeartbeatAt: new Date(Date.now() - 5 * 60 * 1_000),
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: new Date(Date.now() + 30 * 60 * 1_000),
    };

    mockJobQueries({ staleJobs: [mockJob], hardLimitJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    returningFn.mockResolvedValueOnce([{ id: 94 }]);
    mockCreateSnapshot.mockResolvedValue(true);

    await sleepCheckJob();

    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 94,
        sandboxId: 'sb-stale-worker-fallback',
        snapshotIntentId: expect.stringMatching(/^stale_worker-94-/),
        triggerPath: 'stale_worker',
      }),
    );

    const recordedPaths = mockRecordCloudJobEvent.mock.calls
      .map(([, input]) => input.details?.path)
      .filter(Boolean);

    expect(recordedPaths).toContain('stale_worker');
    expect(recordedPaths).not.toContain('hard_limit');
  });

  it('fails stale-worker jobs when the sandbox is already gone', async () => {
    const mockJob = {
      id: 91,
      machineId: 'sb-gone',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'stopped',
      vendor: 'modal',
      workerHeartbeatAt: new Date(Date.now() - 5 * 60 * 1_000),
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ staleJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 91,
      status: RunStatus.Failed,
      error: 'Worker heartbeat stale and instance sb-gone is stopped',
    });
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 91,
        eventType: 'started',
        source: 'sleep_check',
        details: expect.objectContaining({
          preferredPath: 'stale_worker',
          staleWorkerCloudJobId: 91,
        }),
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 91,
        eventType: 'decision',
        source: 'sleep_check',
        details: expect.objectContaining({
          decision: 'instance_status_observed',
          preferredPath: 'stale_worker',
          instanceStatus: 'stopped',
        }),
      }),
    );
  });

  it('finalizes stale-worker jobs as canceled when a stop was requested and the sandbox is already gone', async () => {
    const mockJob = {
      id: 101,
      machineId: 'sb-gone-after-stop',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'stopped',
      vendor: 'modal',
      workerHeartbeatAt: new Date(Date.now() - 5 * 60 * 1_000),
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ staleJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });
    mockDbQueryTaskRunsFindFirst.mockResolvedValue({
      cancelRequestedAt: new Date(),
    });

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 101,
      status: RunStatus.Canceled,
      error:
        'Worker heartbeat stale and instance sb-gone-after-stop is stopped',
    });
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 101,
        eventType: 'decision',
        source: 'sleep_check',
        message: expect.stringContaining('after its stop request'),
      }),
    );
  });

  it('does not fail stale-worker jobs while the sandbox is snapshotting', async () => {
    const mockJob = {
      id: 96,
      machineId: 'sb-snapshotting-stale',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      vendor: 'modal',
      workerHeartbeatAt: new Date(Date.now() - 5 * 60 * 1_000),
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ staleJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({ status: 'snapshotting' });

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockFinishCloudJob).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 96,
        eventType: 'decision',
        source: 'sleep_check',
        details: expect.objectContaining({
          path: 'stale_worker',
          decision: 'snapshot_in_progress',
          instanceStatus: 'snapshotting',
        }),
      }),
    );
  });

  it('does not fail hard-limit candidates while the sandbox is snapshotting', async () => {
    const mockJob = {
      id: 97,
      machineId: 'sb-hard-limit-snapshotting',
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      vendor: 'modal',
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: new Date(Date.now() + 30 * 60 * 1_000),
    };

    mockJobQueries({ hardLimitJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'snapshotting',
      timeoutRemainingMs: 5 * 60 * 1_000,
    });

    await sleepCheckJob();

    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockFinishCloudJob).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 97,
        eventType: 'decision',
        source: 'sleep_check',
        details: expect.objectContaining({
          path: 'hard_limit',
          decision: 'snapshot_in_progress',
          instanceStatus: 'snapshotting',
        }),
      }),
    );
  });

  it('destroys and fails stale non-resumable jobs', async () => {
    const mockJob = {
      id: 92,
      machineId: 'sb-non-resumable-stale',
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      workerHeartbeatAt: new Date(Date.now() - 5 * 60 * 1_000),
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ staleJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    mockDestroyInstance.mockResolvedValue({
      usageObservation: {
        activeCpuDurationMs: 4_321,
      },
    });

    await sleepCheckJob();

    expect(mockDestroyInstance).toHaveBeenCalledWith({
      instanceId: 'sb-non-resumable-stale',
    });
    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 92,
      status: RunStatus.Failed,
      error: 'Worker heartbeat stale for instance sb-non-resumable-stale',
    });
    expect(mockCreateComputeProviderMutationEventRecorder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 92,
      }),
      expect.anything(),
    );
    expect(mockRecordMutation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: 'modal',
        operation: 'destroy_instance',
        eventType: 'started',
        instanceId: 'sb-non-resumable-stale',
      }),
    );
    expect(mockRecordMutation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: 'modal',
        operation: 'destroy_instance',
        eventType: 'completed',
        instanceId: 'sb-non-resumable-stale',
      }),
    );
    expect(mockRecordComputeProviderUsage).toHaveBeenCalledWith({
      cloudJobId: 92,
      lifecycleAction: 'destroy',
      completedAt: expect.any(Date),
      activeCpuDurationMs: 4_321,
      networkIngressBytes: undefined,
      networkEgressBytes: undefined,
      details: expect.objectContaining({
        provider: 'modal',
        path: 'stale_worker',
      }),
    });
    expect(captureBullMqMessageMock).toHaveBeenCalledWith(
      'Sleep check is destroying sandbox after stale worker heartbeat.',
      expect.objectContaining({
        cloudJobId: 92,
        sandboxId: 'sb-non-resumable-stale',
        triggerPath: 'stale_worker',
        rootCauseSummary: 'worker_heartbeat_stale',
      }),
      expect.objectContaining({
        component: 'sleep-check',
        signal: 'sandbox-destroy',
      }),
    );
  });

  it('destroys and cancels stale non-resumable jobs when a stop was requested', async () => {
    const mockJob = {
      id: 102,
      machineId: 'sb-non-resumable-stopped',
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      vendor: 'modal',
      workerHeartbeatAt: new Date(Date.now() - 5 * 60 * 1_000),
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ staleJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    mockDbQueryTaskRunsFindFirst.mockResolvedValue({
      cancelRequestedAt: new Date(),
    });

    await sleepCheckJob();

    expect(mockDestroyInstance).toHaveBeenCalledWith({
      instanceId: 'sb-non-resumable-stopped',
    });
    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 102,
      status: RunStatus.Canceled,
      error: 'Worker heartbeat stale for instance sb-non-resumable-stopped',
    });
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 102,
        eventType: 'decision',
        source: 'sleep_check',
        details: expect.objectContaining({
          decision: 'destroy_and_cancel_after_stop_request',
        }),
      }),
    );
  });

  it('destroys and fails non-resumable booting jobs that miss their initial heartbeat', async () => {
    const mockJob = {
      id: 98,
      machineId: 'sb-non-resumable-booting',
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Processing,
      taskPhase: null,
      vendor: 'modal',
      startedAt: new Date(Date.now() - 5 * 60 * 1_000),
      workerHeartbeatAt: null,
      snapshotId: null,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      sleepAt: null,
    };

    mockJobQueries({ bootingJobs: [mockJob] });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 30 * 60 * 1_000,
    });
    mockDestroyInstance.mockResolvedValue({
      usageObservation: {
        activeCpuDurationMs: 1_234,
      },
    });

    await sleepCheckJob();

    expect(mockDestroyInstance).toHaveBeenCalledWith({
      instanceId: 'sb-non-resumable-booting',
    });
    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 98,
      status: RunStatus.Failed,
      error:
        'Initial worker heartbeat missing for instance sb-non-resumable-booting',
    });
    expect(captureBullMqMessageMock).toHaveBeenCalledWith(
      'Sleep check is destroying sandbox after the worker missed its initial heartbeat.',
      expect.objectContaining({
        cloudJobId: 98,
        sandboxId: 'sb-non-resumable-booting',
        triggerPath: 'booting_no_heartbeat',
        rootCauseSummary: 'booting_no_heartbeat',
      }),
      expect.objectContaining({
        component: 'sleep-check',
        signal: 'sandbox-destroy',
      }),
    );
  });
});

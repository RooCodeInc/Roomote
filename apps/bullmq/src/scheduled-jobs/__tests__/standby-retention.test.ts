import type { Mock } from 'vitest';

const {
  mockCreateComputeProviderClient,
  mockGetInstanceStatus,
  mockEnterStandby,
  mockDestroyInstance,
  mockResolveComputeProviderEnvValues,
  selectResultsQueue,
  selectFn,
  fromFn,
  whereFn,
  updateFn,
  setFn,
  updateWhereFn,
} = vi.hoisted(() => {
  type AnyMock = Mock<(...args: any[]) => any>;

  // Each db.select(...) call consumes one entry; entries resolve in call
  // order. getCandidates chains .orderBy(...), the other queries await the
  // where-result directly, so both shapes must resolve to the same rows.
  const selectResultsQueue: { current: unknown[][] } = { current: [] };

  const makeQueryResult = (rows: unknown[]) => {
    const result = Promise.resolve(rows);

    (result as any).orderBy = () => Promise.resolve(rows);
    return result;
  };

  const whereFn: AnyMock = vi.fn(() =>
    makeQueryResult(selectResultsQueue.current.shift() ?? []),
  );
  const fromFn: AnyMock = vi.fn(() => ({ where: whereFn }));
  const selectFn: AnyMock = vi.fn(() => ({ from: fromFn }));

  const updateWhereFn: AnyMock = vi.fn(() => Promise.resolve([]));
  const setFn: AnyMock = vi.fn(() => ({ where: updateWhereFn }));
  const updateFn: AnyMock = vi.fn(() => ({ set: setFn }));

  return {
    mockCreateComputeProviderClient: vi.fn() as AnyMock,
    mockGetInstanceStatus: vi.fn() as AnyMock,
    mockEnterStandby: vi.fn() as AnyMock,
    mockDestroyInstance: vi.fn() as AnyMock,
    mockResolveComputeProviderEnvValues: vi.fn() as AnyMock,
    selectResultsQueue,
    selectFn,
    fromFn,
    whereFn,
    updateFn,
    setFn,
    updateWhereFn,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    select: selectFn,
    update: updateFn,
  },
  taskRuns: {
    id: 'id',
    taskId: 'taskId',
    vendor: 'vendor',
    status: 'status',
    machineId: 'machineId',
    snapshotId: 'snapshotId',
    snapshotCreatedAt: 'snapshotCreatedAt',
    sourceSnapshotId: 'sourceSnapshotId',
  },
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  or: vi.fn(),
  resolveComputeProviderEnvValues: mockResolveComputeProviderEnvValues,
}));

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: mockCreateComputeProviderClient,
}));

// Import after mocks are set up.
import { standbyRetentionJob } from '../standby-retention';

/**
 * standbyRetentionJob iterates docker, blaxel, azure. Each provider's
 * eviction pass runs two selects (candidates, protected handles); azure
 * additionally runs the orphan re-suspend pass (candidates, protected
 * handles, in-use handles). Queue entries in consumption order.
 */
function queueSelectResults({
  azureReSuspendCandidates = [],
  azureReSuspendProtected = [],
  azureReSuspendInUse = [],
}: {
  azureReSuspendCandidates?: unknown[];
  azureReSuspendProtected?: unknown[];
  azureReSuspendInUse?: unknown[];
}) {
  selectResultsQueue.current = [
    [], // docker eviction candidates
    [], // docker eviction protected
    [], // blaxel eviction candidates
    [], // blaxel eviction protected
    [], // azure eviction candidates
    [], // azure eviction protected
    azureReSuspendCandidates,
    azureReSuspendProtected,
    azureReSuspendInUse,
  ];
}

describe('standbyRetentionJob orphan re-suspend', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    selectResultsQueue.current = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockResolveComputeProviderEnvValues.mockResolvedValue({});
    mockCreateComputeProviderClient.mockReturnValue({
      destroyInstance: mockDestroyInstance,
      getInstanceStatus: mockGetInstanceStatus,
      enterStandby: mockEnterStandby,
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockEnterStandby.mockResolvedValue({ resumeHandle: 'sb-1' });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('re-suspends a retained azure standby found Running with no managing run', async () => {
    queueSelectResults({
      azureReSuspendCandidates: [
        {
          runId: 32,
          taskId: 'task-1',
          provider: 'azure',
          handle: 'sb-1',
          createdAt: new Date(),
        },
      ],
    });

    await standbyRetentionJob();

    expect(mockGetInstanceStatus).toHaveBeenCalledWith({
      instanceId: 'sb-1',
    });
    expect(mockEnterStandby).toHaveBeenCalledWith({ instanceId: 'sb-1' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('re-suspended orphaned azure standby sb-1'),
    );
  });

  it('skips retained handles owned by an active wake session', async () => {
    queueSelectResults({
      azureReSuspendCandidates: [
        {
          runId: 32,
          taskId: 'task-1',
          provider: 'azure',
          handle: 'sb-1',
          createdAt: new Date(),
        },
      ],
      azureReSuspendInUse: [{ machineId: 'sb-1', snapshotId: null }],
    });

    await standbyRetentionJob();

    expect(mockEnterStandby).not.toHaveBeenCalled();
  });

  it('skips handles protected by an active resume run', async () => {
    queueSelectResults({
      azureReSuspendCandidates: [
        {
          runId: 32,
          taskId: 'task-1',
          provider: 'azure',
          handle: 'sb-1',
          createdAt: new Date(),
        },
      ],
      azureReSuspendProtected: [{ handle: 'sb-1' }],
    });

    await standbyRetentionJob();

    expect(mockEnterStandby).not.toHaveBeenCalled();
  });

  it('skips handles that are not live instances (genuine snapshot ids)', async () => {
    queueSelectResults({
      azureReSuspendCandidates: [
        {
          runId: 32,
          taskId: 'task-1',
          provider: 'azure',
          handle: 'snap-1',
          createdAt: new Date(),
        },
      ],
    });
    mockGetInstanceStatus.mockRejectedValue(new Error('not found'));

    await standbyRetentionJob();

    expect(mockEnterStandby).not.toHaveBeenCalled();
  });

  it('does not touch retained instances that are already suspended', async () => {
    queueSelectResults({
      azureReSuspendCandidates: [
        {
          runId: 32,
          taskId: 'task-1',
          provider: 'azure',
          handle: 'sb-1',
          createdAt: new Date(),
        },
      ],
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });

    await standbyRetentionJob();

    expect(mockEnterStandby).not.toHaveBeenCalled();
  });
});

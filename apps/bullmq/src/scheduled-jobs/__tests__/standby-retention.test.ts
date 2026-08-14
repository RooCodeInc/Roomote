import type { Mock } from 'vitest';

const {
  mockCreateComputeProviderClient,
  mockGetInstanceStatus,
  mockEnterStandby,
  mockDestroyInstance,
  mockResolveComputeProviderEnvValues,
  mockFindProtectedTaskWaitSnapshotHandles,
  selectResults,
  selectFn,
  updateFn,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- suppressed for oxlint; ESLint's own rule is offloaded and reports this directive as unused, which is a false positive
  type AnyMock = Mock<(...args: any[]) => any>;

  const selectResults: { current: Record<string, unknown[]> } = { current: {} };

  const makeQueryResult = (rows: unknown[]) => {
    const result = Promise.resolve(rows);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- suppressed for oxlint (see above)
    (result as any).orderBy = () => Promise.resolve(rows);
    return result;
  };

  const findProvider = (expression: unknown): string | undefined => {
    if (!expression || typeof expression !== 'object') return undefined;
    const node = expression as {
      kind?: string;
      column?: string;
      value?: string;
      clauses?: unknown[];
    };
    if (node.kind === 'eq' && node.column === 'vendor') return node.value;
    return node.clauses?.map(findProvider).find(Boolean);
  };
  const selectFn: AnyMock = vi.fn((selection: Record<string, unknown>) => ({
    from: vi.fn(() => ({
      where: vi.fn((expression: unknown) => {
        const provider = findProvider(expression);
        const kind =
          'runId' in selection
            ? 'candidates'
            : 'machineId' in selection
              ? 'inUse'
              : 'protected';
        return makeQueryResult(
          selectResults.current[`${provider}:${kind}`] ?? [],
        );
      }),
    })),
  }));

  const updateWhereFn: AnyMock = vi.fn(() => Promise.resolve([]));
  const setFn: AnyMock = vi.fn(() => ({ where: updateWhereFn }));
  const updateFn: AnyMock = vi.fn(() => ({ set: setFn }));

  return {
    mockCreateComputeProviderClient: vi.fn() as AnyMock,
    mockGetInstanceStatus: vi.fn() as AnyMock,
    mockEnterStandby: vi.fn() as AnyMock,
    mockDestroyInstance: vi.fn() as AnyMock,
    mockResolveComputeProviderEnvValues: vi.fn() as AnyMock,
    mockFindProtectedTaskWaitSnapshotHandles: vi.fn() as AnyMock,
    selectResults,
    selectFn,
    updateFn,
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
    waitUntil: 'waitUntil',
    waitResumedAt: 'waitResumedAt',
    waitResumeRunId: 'waitResumeRunId',
  },
  and: vi.fn((...clauses: unknown[]) => ({ kind: 'and', clauses })),
  desc: vi.fn(),
  eq: vi.fn((column: string, value: string) => ({
    kind: 'eq',
    column,
    value,
  })),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
  or: vi.fn(),
  findProtectedTaskWaitSnapshotHandles:
    mockFindProtectedTaskWaitSnapshotHandles,
  resolveComputeProviderEnvValues: mockResolveComputeProviderEnvValues,
}));

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: mockCreateComputeProviderClient,
}));

// Import after mocks are set up.
import { standbyRetentionJob } from '../standby-retention';

/**
 * Configure provider-specific query results without depending on the order of
 * the concurrent retention passes.
 */
function queueSelectResults({
  boxReSuspendCandidates = [],
  boxReSuspendProtected = [],
  boxReSuspendInUse = [],
  azureReSuspendCandidates = [],
  azureReSuspendProtected = [],
  azureReSuspendInUse = [],
}: {
  boxReSuspendCandidates?: unknown[];
  boxReSuspendProtected?: unknown[];
  boxReSuspendInUse?: unknown[];
  azureReSuspendCandidates?: unknown[];
  azureReSuspendProtected?: unknown[];
  azureReSuspendInUse?: unknown[];
}) {
  selectResults.current = {
    'box:candidates': boxReSuspendCandidates,
    'box:protected': boxReSuspendProtected,
    'box:inUse': boxReSuspendInUse,
    'azure:candidates': azureReSuspendCandidates,
    'azure:protected': azureReSuspendProtected,
    'azure:inUse': azureReSuspendInUse,
  };
}

describe('standbyRetentionJob orphan re-suspend', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    selectResults.current = {};
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockResolveComputeProviderEnvValues.mockResolvedValue({});
    mockFindProtectedTaskWaitSnapshotHandles.mockResolvedValue([]);
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

  it('constructs a Box client and re-suspends an orphaned Box standby', async () => {
    mockResolveComputeProviderEnvValues.mockImplementation((provider) =>
      Promise.resolve(provider === 'box' ? { BOX_API_KEY: 'box-key' } : {}),
    );
    queueSelectResults({
      boxReSuspendCandidates: [
        {
          runId: 33,
          taskId: 'task-box',
          provider: 'box',
          handle: 'box-standby',
          createdAt: new Date(),
        },
      ],
    });

    await standbyRetentionJob();

    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith({
      provider: 'box',
      envFallback: { BOX_API_KEY: 'box-key' },
    });
    expect(mockGetInstanceStatus).toHaveBeenCalledWith({
      instanceId: 'box-standby',
    });
    expect(mockEnterStandby).toHaveBeenCalledWith({
      instanceId: 'box-standby',
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('re-suspended orphaned box standby box-standby'),
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

  it('skips handles whose claimed wait child was canceled', async () => {
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
    mockFindProtectedTaskWaitSnapshotHandles.mockResolvedValue(['sb-1']);

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

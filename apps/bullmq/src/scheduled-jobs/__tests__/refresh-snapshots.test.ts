// Hoist mock functions so they're available inside vi.mock factories.
const {
  mockEnvironmentSnapshotsFindMany,
  mockEnvironmentSnapshotsFindFirst,
  mockEnvironmentsFindMany,
  mockClaimPendingEnvironmentSnapshotForAttachment,
  mockResolveDefaultComputeProvider,
  mockUpdatePendingEnvironmentSnapshot,
  mockEnqueueTask,
} = vi.hoisted(() => ({
  mockEnvironmentSnapshotsFindMany: vi.fn(),
  mockEnvironmentSnapshotsFindFirst: vi.fn(),
  mockEnvironmentsFindMany: vi.fn(),
  mockClaimPendingEnvironmentSnapshotForAttachment: vi.fn(),
  mockResolveDefaultComputeProvider: vi.fn(),
  mockUpdatePendingEnvironmentSnapshot: vi.fn(),
  mockEnqueueTask: vi.fn(),
}));

// findActiveSnapshotRefreshJob's select().from().innerJoin().where()
// .orderBy().limit() chain; always resolves to "no active run".
function makeSelectChain() {
  const chain: Record<string, unknown> = {};

  for (const method of ['from', 'innerJoin', 'where', 'orderBy']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain.limit = vi.fn().mockResolvedValue([]);

  return chain;
}

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );
  return {
    ...actual,
    db: {
      query: {
        environmentSnapshots: {
          findMany: (...args: unknown[]) =>
            mockEnvironmentSnapshotsFindMany(...args),
          findFirst: (...args: unknown[]) =>
            mockEnvironmentSnapshotsFindFirst(...args),
        },
        environments: {
          findMany: (...args: unknown[]) => mockEnvironmentsFindMany(...args),
        },
      },
      select: () => makeSelectChain(),
    },
    claimPendingEnvironmentSnapshotForAttachment: (...args: unknown[]) =>
      mockClaimPendingEnvironmentSnapshotForAttachment(...args),
    resolveDefaultComputeProvider: (...args: unknown[]) =>
      mockResolveDefaultComputeProvider(...args),
    updatePendingEnvironmentSnapshot: (...args: unknown[]) =>
      mockUpdatePendingEnvironmentSnapshot(...args),
  };
});

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
}));

import {
  launchMissingEnvironmentSnapshot,
  refreshSnapshotsJob,
  SNAPSHOT_REFRESH_LAUNCH_SPACING_MS,
} from '../refresh-snapshots';

function makeEnvironment(id: string) {
  return {
    id,
    name: `env ${id}`,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

function makeClaim(environmentId: string) {
  const claimedAt = new Date('2026-08-13T00:00:00.000Z');
  return {
    environmentSnapshotId: `snapshot-row-${environmentId}`,
    claimedAt,
    attachmentSource: {
      source: 'pending_snapshot_row' as const,
      environmentSnapshotId: `snapshot-row-${environmentId}`,
      claimedAt: claimedAt.toISOString(),
    },
  };
}

describe('refreshSnapshotsJob launch pacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No snapshot rows: every environment becomes a
    // 'missing_default_provider_snapshot' candidate that wants a launch.
    mockEnvironmentSnapshotsFindMany.mockResolvedValue([]);
    mockEnvironmentSnapshotsFindFirst.mockResolvedValue(undefined);
    mockResolveDefaultComputeProvider.mockResolvedValue('modal');
    mockClaimPendingEnvironmentSnapshotForAttachment.mockImplementation(
      async (_db: unknown, params: { environmentId: string }) =>
        makeClaim(params.environmentId),
    );
    let nextRunId = 100;
    mockEnqueueTask.mockImplementation(async () => ({ id: nextRunId++ }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spaces consecutive launches by the launch spacing interval', async () => {
    vi.useFakeTimers();
    mockEnvironmentsFindMany.mockResolvedValue([
      makeEnvironment('env-1'),
      makeEnvironment('env-2'),
      makeEnvironment('env-3'),
    ]);

    const jobPromise = refreshSnapshotsJob();

    // The first launch happens immediately, without any pacing delay.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);

    // The second candidate reserves its pending claim BEFORE the pacing
    // sleep, so concurrent claimants are locked out during the wait.
    expect(
      mockClaimPendingEnvironmentSnapshotForAttachment,
    ).toHaveBeenCalledTimes(2);

    // The second launch waits out the full spacing interval.
    await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_LAUNCH_SPACING_MS - 1);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_LAUNCH_SPACING_MS);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(3);

    // No trailing sleep after the last candidate: the job settles without
    // advancing the clock any further.
    await jobPromise;
  });

  it('finishes without sleeping when there is a single candidate', async () => {
    mockEnvironmentsFindMany.mockResolvedValue([makeEnvironment('env-1')]);

    // Real timers: a stray pacing sleep would blow the test timeout.
    await refreshSnapshotsJob();

    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);
  });

  it('does not sleep after a launch when every remaining candidate is skipped', async () => {
    mockEnvironmentsFindMany.mockResolvedValue([
      makeEnvironment('env-1'),
      makeEnvironment('env-2'),
      makeEnvironment('env-3'),
    ]);
    // env-1 launches; env-2 and env-3 already hold a fresh pending claim, so
    // their skip check fires before any pacing sleep.
    mockEnvironmentSnapshotsFindFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({
        snapshotStatus: 'pending',
        updatedAt: new Date(),
      });

    // Real timers: a trailing pacing sleep would blow the test timeout.
    await refreshSnapshotsJob();

    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);
  });

  it('does not sleep for candidates whose claim was taken by a concurrent claimant', async () => {
    mockEnvironmentsFindMany.mockResolvedValue([
      makeEnvironment('env-1'),
      makeEnvironment('env-2'),
      makeEnvironment('env-3'),
    ]);
    // env-1 claims and launches; env-2 and env-3 lose their claim (e.g. the
    // admin snapshot command got there first). The claim precedes pacing, so
    // the lost claims skip without ever sleeping.
    mockClaimPendingEnvironmentSnapshotForAttachment
      .mockImplementationOnce(
        async (_db: unknown, params: { environmentId: string }) =>
          makeClaim(params.environmentId),
      )
      .mockResolvedValue(null);

    // Real timers: a pacing sleep for a lost claim would blow the test timeout.
    await refreshSnapshotsJob();

    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);
  });

  it('does not sleep for skipped candidates', async () => {
    mockEnvironmentsFindMany.mockResolvedValue([
      makeEnvironment('env-1'),
      makeEnvironment('env-2'),
      makeEnvironment('env-3'),
    ]);
    // Every claim is already held elsewhere, so no launches happen at all.
    mockClaimPendingEnvironmentSnapshotForAttachment.mockResolvedValue(null);

    // Real timers: any pacing sleep for a skip would blow the test timeout.
    await refreshSnapshotsJob();

    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });
});

describe('launchMissingEnvironmentSnapshot', () => {
  const target = { environmentId: 'env-1', provider: 'modal' as const };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvironmentSnapshotsFindFirst.mockResolvedValue(undefined);
    mockClaimPendingEnvironmentSnapshotForAttachment.mockImplementation(
      async (_db: unknown, params: { environmentId: string }) =>
        makeClaim(params.environmentId),
    );
  });

  it('launches the build against the row it claimed', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 42 });
    const paceBeforeLaunch = vi.fn().mockResolvedValue(undefined);

    const result = await launchMissingEnvironmentSnapshot(target, {
      paceBeforeLaunch,
    });

    expect(result).toEqual({ kind: 'enqueued', runId: 42 });
    expect(paceBeforeLaunch).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'env_snapshot',
        task: expect.objectContaining({
          computeProvider: 'modal',
          payload: expect.objectContaining({
            environmentId: 'env-1',
            environmentSnapshotAttachment: makeClaim('env-1').attachmentSource,
          }),
        }),
      }),
    );
  });

  it('asks the claim for no live row only when the caller requires it', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 42 });

    await launchMissingEnvironmentSnapshot(target, {
      paceBeforeLaunch: async () => {},
    });
    await launchMissingEnvironmentSnapshot(target, {
      paceBeforeLaunch: async () => {},
      requireNoSnapshotRow: true,
    });

    const claimParams =
      mockClaimPendingEnvironmentSnapshotForAttachment.mock.calls.map(
        ([, params]) => params as { requireNoSnapshotRow?: boolean },
      );
    expect(claimParams[0]?.requireNoSnapshotRow).toBeUndefined();
    expect(claimParams[1]?.requireNoSnapshotRow).toBe(true);
  });

  it('skips without pacing when the claim is lost', async () => {
    mockClaimPendingEnvironmentSnapshotForAttachment.mockResolvedValue(null);
    const paceBeforeLaunch = vi.fn().mockResolvedValue(undefined);

    const result = await launchMissingEnvironmentSnapshot(target, {
      paceBeforeLaunch,
    });

    expect(result).toEqual({ kind: 'skipped' });
    expect(paceBeforeLaunch).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('records the claimed row as failed when the launch throws', async () => {
    mockEnqueueTask.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      launchMissingEnvironmentSnapshot(target, {
        paceBeforeLaunch: async () => {},
      }),
    ).rejects.toThrow('queue unavailable');

    expect(mockUpdatePendingEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        provider: 'modal',
        snapshotStatus: 'failed',
        attachmentSource: makeClaim('env-1').attachmentSource,
      }),
    );
  });
});

/**
 * Regression coverage for the snapshot-loss incident, run against the real
 * database rather than a mocked `db`.
 *
 * The unit tests in `snapshot.test.ts` mock every query, so they prove the
 * job's control flow but not that the guarded `snapshot_id IS NULL` update
 * actually behaves that way in Postgres -- which is the whole mechanism the
 * fix depends on. These tests replay the incident end to end at the job
 * level: attempt 1 hands over a snapshot id and then dies during teardown,
 * and the redelivered attempt 2 finds the sandbox already stopped.
 *
 * Only the compute provider and the outbound integrations are stubbed. Every
 * task_runs read and write here is real SQL.
 */
import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskRuns,
  taskRunEvents,
} from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

const { mockGetInstanceStatus, mockCreateSnapshot } = vi.hoisted(() => ({
  mockGetInstanceStatus: vi.fn(),
  mockCreateSnapshot: vi.fn(),
}));

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: () => ({
    vendor: 'modal',
    getInstanceStatus: mockGetInstanceStatus,
    createSnapshot: mockCreateSnapshot,
    // Deliberately absent, matching Modal: there is no way to look a snapshot
    // up by its source instance, so nothing can recover a lost id.
    findSnapshotBySourceInstance: undefined,
  }),
}));

vi.mock('@roomote/linear', () => ({
  drainLinearMessagesToResumeRun: vi.fn().mockResolvedValue({ resumed: false }),
}));

vi.mock('@roomote/slack', () => ({
  drainSlackMessagesToResumeRun: vi.fn().mockResolvedValue({ resumed: false }),
}));

vi.mock('@roomote/sdk/server', () => ({
  withSandboxServerRpcClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../compute-provider-usage', () => ({
  tryRecordComputeProviderUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../monitoring/sentry', () => ({
  captureBullMqMessage: vi.fn(),
}));

import { snapshotJob } from './snapshot';

const SANDBOX_ID = 'sb-persistence-regression';

async function createIdleRunAwaitingSnapshot() {
  const task = await taskFactory.create();

  return runFactory.create({
    taskId: task.id,
    payloadKind: TaskPayloadKind.StandardTask,
    payload: { repo: 'test/repo', description: 'snapshot persistence' },
    status: RunStatus.Idle,
    vendor: 'modal',
    machineId: SANDBOX_ID,
    // Stamped by sleep-check when it claims the snapshot handoff.
    snapshotRequestedAt: new Date(),
    sleepRequestedAt: new Date(),
  });
}

function buildJob(runId: number, attemptsMade: number) {
  return {
    id: `due_sleep-${runId}`,
    attemptsMade,
    opts: { attempts: 3 },
    data: {
      runId,
      sandboxId: SANDBOX_ID,
      snapshotIntentId: `due_sleep-${runId}`,
      triggerPath: 'due_sleep',
    },
  } as never;
}

async function readRun(runId: number) {
  const row = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!row) {
    throw new Error(`Task run #${runId} disappeared`);
  }

  return row;
}

/**
 * Reproduces the incident faithfully: the provider yields an id, and then the
 * attempt never progresses again because its process stopped renewing the
 * BullMQ lock. Nothing further in that attempt runs -- so this cannot be
 * modelled with a thrown error, which would still run the catch block.
 */
function startStalledAttempt(runId: number, snapshotId: string) {
  mockCreateSnapshot.mockImplementation(async ({ onSnapshotCreated }) => {
    await onSnapshotCreated?.(snapshotId);
    // Modal terminates the sandbox here. This attempt hangs instead.
    return new Promise(() => {});
  });

  // Deliberately not awaited: the attempt is stalled, exactly as in the
  // incident. Swallow any late rejection so it cannot fail an unrelated test.
  void snapshotJob(buildJob(runId, 0)).catch(() => {});
}

async function waitForSnapshotId(runId: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = await readRun(runId);

    if (row.snapshotId) {
      return row;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Snapshot id was never persisted for task run #${runId}`);
}

describe('snapshot id persistence (real database)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the snapshot id while the attempt is still in flight', async () => {
    const run = await createIdleRunAwaitingSnapshot();

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    startStalledAttempt(run.id, 'im-incident-replay');

    // Nothing in attempt 1 will ever run again -- not its teardown, not its
    // catch block, not its finalizing transaction. The id has to already be
    // durable at this point or it is gone for good.
    const inFlight = await waitForSnapshotId(run.id);

    expect(inFlight.snapshotId).toBe('im-incident-replay');
    expect(inFlight.snapshotCreatedAt).toBeInstanceOf(Date);
    expect(inFlight.snapshotFailedAt).toBeNull();
    expect(inFlight.status).toBe(RunStatus.Idle);
  });

  it('finalizes a redelivered attempt from the persisted id instead of failing on the stopped sandbox', async () => {
    const run = await createIdleRunAwaitingSnapshot();

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    startStalledAttempt(run.id, 'im-incident-replay');

    const persisted = await waitForSnapshotId(run.id);
    const originalCreatedAt = persisted.snapshotCreatedAt;

    // BullMQ redelivers the stalled job. The sandbox is now stopped, because
    // the first attempt snapshotted it successfully -- the precise condition
    // that used to finalize the run without a snapshot and strand the task.
    vi.clearAllMocks();
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });

    await snapshotJob(buildJob(run.id, 1));

    const finalized = await readRun(run.id);

    expect(finalized.status).toBe(RunStatus.Completed);
    expect(finalized.snapshotId).toBe('im-incident-replay');
    expect(finalized.snapshotFailedAt).toBeNull();
    expect(finalized.sleepAt).toBeNull();
    // Re-snapshotting is impossible once the sandbox is gone, so the job must
    // not even try -- and must not consult the dead instance.
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockGetInstanceStatus).not.toHaveBeenCalled();
    // Expiry still runs from the real creation time, not the redelivery.
    expect(finalized.snapshotCreatedAt?.toISOString()).toBe(
      originalCreatedAt?.toISOString(),
    );

    const events = await db.query.taskRunEvents.findMany({
      where: eq(taskRunEvents.runId, run.id),
    });
    const decisions = events.map((event) => event.details?.decision);

    expect(decisions).toContain('persist_snapshot_id_before_teardown');
    expect(decisions).toContain('reuse_persisted_snapshot');
  });

  it('finalizes in place when the attempt fails after the id was recorded', async () => {
    const run = await createIdleRunAwaitingSnapshot();

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockImplementation(async ({ onSnapshotCreated }) => {
      await onSnapshotCreated?.('im-teardown-failure');
      throw new Error('teardown exploded');
    });

    // Final attempt, so the job would raise UnrecoverableError and BullMQ
    // would never redeliver it.
    await snapshotJob(buildJob(run.id, 2));

    const finalized = await readRun(run.id);

    // Nothing else can rescue this run: sleep-check's candidate query skips
    // rows that carry a snapshot id or a pending snapshot request, and there
    // is no redelivery to short-circuit. Leaving it Idle would strand the
    // task forever while holding a perfectly good snapshot.
    expect(finalized.status).toBe(RunStatus.Completed);
    expect(finalized.snapshotId).toBe('im-teardown-failure');
    expect(finalized.snapshotFailedAt).toBeNull();

    const events = await db.query.taskRunEvents.findMany({
      where: eq(taskRunEvents.runId, run.id),
    });

    expect(events.map((event) => event.details?.decision)).toContain(
      'recover_persisted_snapshot_after_failure',
    );
  });

  /**
   * Both attempts overlap: the row is still empty when the attempt under test
   * starts, so its short-circuit does not fire, and a competitor claims the
   * row while it is mid-snapshot. The finalizing update is unconditional, so
   * a loser that finalizes its own id would overwrite the recorded one and
   * point the run at a snapshot no consumer ever saw.
   */
  function claimRowMidFlight(runId: number, winnerCreatedAt: Date) {
    return async (
      snapshotId: string,
      onSnapshotCreated?: (id: string) => Promise<void>,
    ) => {
      await db
        .update(taskRuns)
        .set({ snapshotId: 'im-winner', snapshotCreatedAt: winnerCreatedAt })
        .where(eq(taskRuns.id, runId));
      await onSnapshotCreated?.(snapshotId);
    };
  }

  it('finalizes the winning id when a concurrent attempt claims the row mid-flight', async () => {
    const run = await createIdleRunAwaitingSnapshot();
    const winnerCreatedAt = new Date('2026-04-24T06:29:00.000Z');
    const claim = claimRowMidFlight(run.id, winnerCreatedAt);

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockImplementation(async ({ onSnapshotCreated }) => {
      await claim('im-loser', onSnapshotCreated);
      return { snapshotId: 'im-loser' };
    });

    await snapshotJob(buildJob(run.id, 0));

    const finalized = await readRun(run.id);

    expect(finalized.snapshotId).toBe('im-winner');
    expect(finalized.snapshotCreatedAt?.toISOString()).toBe(
      winnerCreatedAt.toISOString(),
    );
    expect(finalized.status).toBe(RunStatus.Completed);
  });

  it('finalizes the winning id when a losing attempt then fails during teardown', async () => {
    const run = await createIdleRunAwaitingSnapshot();
    const winnerCreatedAt = new Date('2026-04-24T06:29:00.000Z');
    const claim = claimRowMidFlight(run.id, winnerCreatedAt);

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockImplementation(async ({ onSnapshotCreated }) => {
      await claim('im-loser', onSnapshotCreated);
      throw new Error('teardown exploded');
    });

    await snapshotJob(buildJob(run.id, 2));

    const finalized = await readRun(run.id);

    // The recovery path must recover the recorded snapshot, not this
    // attempt's own.
    expect(finalized.snapshotId).toBe('im-winner');
    expect(finalized.snapshotCreatedAt?.toISOString()).toBe(
      winnerCreatedAt.toISOString(),
    );
    expect(finalized.status).toBe(RunStatus.Completed);
  });

  it('does not let a losing concurrent attempt overwrite the recorded snapshot', async () => {
    const run = await createIdleRunAwaitingSnapshot();

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    startStalledAttempt(run.id, 'im-first-writer');

    await waitForSnapshotId(run.id);

    // A second attempt somehow produces a different image. The guarded update
    // must leave the already-recorded id alone rather than pointing the run at
    // a snapshot the first writer's consumers never saw.
    vi.clearAllMocks();
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockImplementation(async ({ onSnapshotCreated }) => {
      await onSnapshotCreated?.('im-second-writer');
      return { snapshotId: 'im-second-writer' };
    });

    await snapshotJob(buildJob(run.id, 1));

    const finalized = await readRun(run.id);

    expect(finalized.snapshotId).toBe('im-first-writer');
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });
});

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

describe('snapshot id persistence (real database)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the snapshot id when the attempt dies after the provider produced it', async () => {
    const run = await createIdleRunAwaitingSnapshot();

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockImplementation(async ({ onSnapshotCreated }) => {
      await onSnapshotCreated?.('im-incident-replay');
      // Modal terminates the sandbox here. This is the exact window where the
      // original incident lost the id: the process stopped renewing its lock
      // and the job was redelivered before it could record anything.
      throw new Error('worker died during post-snapshot teardown');
    });

    await expect(snapshotJob(buildJob(run.id, 0))).rejects.toThrow();

    const afterCrash = await readRun(run.id);

    // The snapshot survived the crash -- this is the entire fix.
    expect(afterCrash.snapshotId).toBe('im-incident-replay');
    expect(afterCrash.snapshotCreatedAt).toBeInstanceOf(Date);
    expect(afterCrash.snapshotFailedAt).toBeNull();
    // The failure path must not have cleared the id it found on the row.
    expect(afterCrash.status).toBe(RunStatus.Idle);
  });

  it('finalizes a redelivered attempt from the persisted id instead of failing on the stopped sandbox', async () => {
    const run = await createIdleRunAwaitingSnapshot();

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockImplementation(async ({ onSnapshotCreated }) => {
      await onSnapshotCreated?.('im-incident-replay');
      throw new Error('worker died during post-snapshot teardown');
    });

    await expect(snapshotJob(buildJob(run.id, 0))).rejects.toThrow();

    const persisted = await readRun(run.id);
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

  it('does not let a losing concurrent attempt overwrite the recorded snapshot', async () => {
    const run = await createIdleRunAwaitingSnapshot();

    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockImplementation(async ({ onSnapshotCreated }) => {
      await onSnapshotCreated?.('im-first-writer');
      throw new Error('worker died during post-snapshot teardown');
    });

    await expect(snapshotJob(buildJob(run.id, 0))).rejects.toThrow();

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

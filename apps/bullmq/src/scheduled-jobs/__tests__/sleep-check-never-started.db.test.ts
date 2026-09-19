import { randomUUID } from 'node:crypto';

import { db, eq, inArray, taskFactory, taskRuns } from '@roomote/db/server';
import {
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS,
  RunStatus,
  TaskPayloadKind,
  WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE,
} from '@roomote/types';

import {
  claimNeverStartedRun,
  findBootingRunsWithoutHeartbeat,
  findNeverStartedRunsWithoutInstance,
} from '../sleep-check';

/**
 * Runs the real selection queries. A run whose worker never reported has no
 * `startedAt`, and every recovery path used to key on a column such a run
 * never sets, so it was selected by none of them. Mocks cannot show that.
 */
describe('sleep check selection of runs whose worker never started (real database)', () => {
  const now = new Date();
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000);
  // Comfortably past the launch budget, and comfortably inside it.
  const overdue = minutesAgo(ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS / 60_000 + 30);
  const recent = minutesAgo(1);
  const createdRunIds: number[] = [];

  async function insertRun(values: Partial<typeof taskRuns.$inferInsert>) {
    const task = await taskFactory.create();
    const [run] = await db
      .insert(taskRuns)
      .values({
        taskId: task.id,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'acme/repo', description: 'never-started test' },
        status: RunStatus.Preparing,
        vendor: 'modal',
        machineId: `sb-${randomUUID()}`,
        ...values,
      })
      .returning({ id: taskRuns.id });
    createdRunIds.push(run!.id);
    return run!.id;
  }

  const selectedIds = async (
    find: (at: Date) => PromiseLike<Array<{ id: number }>>,
  ) => {
    const rows = await find(now);
    return rows.map((row) => row.id).filter((id) => createdRunIds.includes(id));
  };

  afterAll(async () => {
    if (createdRunIds.length > 0) {
      await db.delete(taskRuns).where(inArray(taskRuns.id, createdRunIds));
    }
  });

  it('selects a provisioned run whose worker never reported, once the launch budget is spent', async () => {
    const neverStarted = await insertRun({
      dequeuedAt: overdue,
      provisionReadyAt: overdue,
    });
    // No `provisionReadyAt` either: measured from the dequeue instead.
    const neverProvisioned = await insertRun({ dequeuedAt: overdue });
    const stillLaunching = await insertRun({
      dequeuedAt: recent,
      provisionReadyAt: recent,
    });

    const selected = await selectedIds(findBootingRunsWithoutHeartbeat);

    expect(selected).toContain(neverStarted);
    expect(selected).toContain(neverProvisioned);
    expect(selected).not.toContain(stillLaunching);
  });

  it('keeps selecting a run that started and then missed its first heartbeat', async () => {
    const missedFirstHeartbeat = await insertRun({
      dequeuedAt: minutesAgo(6),
      startedAt: minutesAgo(5),
    });

    await expect(
      selectedIds(findBootingRunsWithoutHeartbeat),
    ).resolves.toContain(missedFirstHeartbeat);
  });

  it('leaves alone runs that other recovery owns or that are finished', async () => {
    // Still `dequeued`: the controller's orphan scan re-runs these.
    const orphanScanOwned = await insertRun({
      status: RunStatus.Dequeued,
      dequeuedAt: overdue,
    });
    const reporting = await insertRun({
      dequeuedAt: overdue,
      startedAt: overdue,
      workerHeartbeatAt: recent,
    });
    const finished = await insertRun({
      status: RunStatus.Failed,
      dequeuedAt: overdue,
      completedAt: overdue,
    });
    const alreadySnapshotting = await insertRun({
      dequeuedAt: overdue,
      snapshotRequestedAt: recent,
    });

    const selected = await selectedIds(findBootingRunsWithoutHeartbeat);

    expect(selected).not.toContain(orphanScanOwned);
    expect(selected).not.toContain(reporting);
    expect(selected).not.toContain(finished);
    expect(selected).not.toContain(alreadySnapshotting);
  });

  it('lets exactly one of two overlapping sweeps claim a run', async () => {
    const id = await insertRun({ machineId: null, dequeuedAt: overdue });
    const [job] = (await findNeverStartedRunsWithoutInstance(now)).filter(
      (row) => row.id === id,
    );

    const claims = await Promise.all([
      claimNeverStartedRun(job!, now),
      claimNeverStartedRun(job!, now),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    // Claimed, so the next sweep does not select it again...
    await expect(
      selectedIds(findNeverStartedRunsWithoutInstance),
    ).resolves.not.toContain(id);
  });

  it('takes over a claim whose sweep never finished', async () => {
    // A process that died between claiming and settling must not leave the
    // run stuck again: the claim is a lease.
    const abandonedWithoutInstance = await insertRun({
      machineId: null,
      dequeuedAt: overdue,
      sleepRequestedAt: minutesAgo(60),
    });
    const abandonedWithInstance = await insertRun({
      dequeuedAt: overdue,
      sleepRequestedAt: minutesAgo(60),
    });
    const freshlyClaimed = await insertRun({
      dequeuedAt: overdue,
      sleepRequestedAt: minutesAgo(1),
    });

    await expect(
      selectedIds(findNeverStartedRunsWithoutInstance),
    ).resolves.toContain(abandonedWithoutInstance);
    const withInstance = await selectedIds(findBootingRunsWithoutHeartbeat);
    expect(withInstance).toContain(abandonedWithInstance);
    expect(withInstance).not.toContain(freshlyClaimed);
  });

  it('does not claim a run that changed after it was selected', async () => {
    const id = await insertRun({ machineId: null, dequeuedAt: overdue });
    const [job] = (await findNeverStartedRunsWithoutInstance(now)).filter(
      (row) => row.id === id,
    );
    // The worker reported in between the select and the claim.
    await db
      .update(taskRuns)
      .set({ startedAt: new Date() })
      .where(eq(taskRuns.id, id));

    await expect(claimNeverStartedRun(job!, now)).resolves.toBe(false);
  });

  it('selects a never-started run with no instance separately, and not one waiting for capacity', async () => {
    const noInstance = await insertRun({
      machineId: null,
      dequeuedAt: overdue,
    });
    const waitingForCapacity = await insertRun({
      machineId: null,
      dequeuedAt: overdue,
      taskPhase: WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE,
    });
    const noInstanceStillLaunching = await insertRun({
      machineId: null,
      dequeuedAt: recent,
    });
    const hasInstance = await insertRun({ dequeuedAt: overdue });

    const withoutInstance = await selectedIds(
      findNeverStartedRunsWithoutInstance,
    );

    expect(withoutInstance).toContain(noInstance);
    expect(withoutInstance).not.toContain(waitingForCapacity);
    expect(withoutInstance).not.toContain(noInstanceStillLaunching);
    expect(withoutInstance).not.toContain(hasInstance);
    // The instance-keyed recovery cannot reach it, which is why it needs its
    // own path.
    await expect(
      selectedIds(findBootingRunsWithoutHeartbeat),
    ).resolves.not.toContain(noInstance);
  });
});

import { randomUUID } from 'node:crypto';

import { db, inArray, taskFactory, taskRuns } from '@roomote/db/server';
import {
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS,
  RunStatus,
  TaskPayloadKind,
  WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE,
} from '@roomote/types';

import {
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

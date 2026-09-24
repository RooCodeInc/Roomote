import { randomUUID } from 'node:crypto';

import { db, inArray, taskFactory, taskRuns } from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

import { findFinishedRunsWithSandbox } from '../sleep-check';

/**
 * Runs the real selection query for sandboxes that outlived their run. Every
 * other sleep-check path looks only at active statuses, so a run that failed
 * or was canceled with its sandbox still up was selected by none of them.
 */
describe('sleep check selection of finished runs that may still hold a sandbox (real database)', () => {
  const now = new Date();
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000);
  const createdRunIds: number[] = [];

  async function insertRun(values: Partial<typeof taskRuns.$inferInsert>) {
    const task = await taskFactory.create();
    const [run] = await db
      .insert(taskRuns)
      .values({
        taskId: task.id,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'acme/repo', description: 'finished-run test' },
        status: RunStatus.Failed,
        vendor: 'roomote',
        machineId: `sb-${randomUUID()}`,
        completedAt: minutesAgo(30),
        ...values,
      })
      .returning({ id: taskRuns.id });
    createdRunIds.push(run!.id);
    return run!.id;
  }

  const selectedIds = async () => {
    const rows = await findFinishedRunsWithSandbox(now);
    return rows.map((row) => row.id).filter((id) => createdRunIds.includes(id));
  };

  afterAll(async () => {
    if (createdRunIds.length > 0) {
      await db.delete(taskRuns).where(inArray(taskRuns.id, createdRunIds));
    }
  });

  it('selects failed, canceled, and completed runs whose sandbox was never retired', async () => {
    const failed = await insertRun({});
    const canceledWithoutCompletion = await insertRun({
      status: RunStatus.Canceled,
      completedAt: null,
      canceledAt: minutesAgo(30),
    });
    const completed = await insertRun({ status: RunStatus.Completed });

    const selected = await selectedIds();

    expect(selected).toContain(failed);
    expect(selected).toContain(canceledWithoutCompletion);
    expect(selected).toContain(completed);
  });

  it('leaves alone runs that were retired, are too fresh or too old, or have no sandbox', async () => {
    const alreadyHandled = await insertRun({
      sleepRequestedAt: minutesAgo(29),
    });
    const snapshotted = await insertRun({ snapshotId: 'im-snapshot' });
    const justFinished = await insertRun({ completedAt: minutesAgo(1) });
    const pastProviderTimeout = await insertRun({
      completedAt: minutesAgo(25 * 60),
    });
    const noSandbox = await insertRun({ machineId: null });
    const stillIdle = await insertRun({
      status: RunStatus.Idle,
      completedAt: null,
    });

    const selected = await selectedIds();

    expect(selected).not.toContain(alreadyHandled);
    expect(selected).not.toContain(snapshotted);
    expect(selected).not.toContain(justFinished);
    expect(selected).not.toContain(pastProviderTimeout);
    expect(selected).not.toContain(noSandbox);
    expect(selected).not.toContain(stillIdle);
  });
});

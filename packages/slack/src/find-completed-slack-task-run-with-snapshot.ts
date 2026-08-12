import {
  db,
  tasks,
  taskRuns,
  eq,
  and,
  gt,
  inArray,
  isNull,
  isNotNull,
  desc,
} from '@roomote/db/server';
import { RunStatus, SANDBOX_SNAPSHOT_EXPIRY_MS } from '@roomote/types';

import { slackDebug } from './logging';

/**
 * Find the most recent completed/idle run for a Slack thread that has a
 * valid snapshot. Used to determine whether a follow-up message can resume
 * from a previous sandbox snapshot instead of starting fresh.
 *
 * Matches by the tasks.slackThreadTs channel binding, which is stable within
 * a single Slack thread (1:N thread-to-task; latest run wins).
 * Callers with an immutable task binding can pass taskId to scope the lookup.
 *
 * Returns the run row needed to construct a SnapshotResume launch, or null
 * if no suitable run exists.
 */
export async function findCompletedSlackTaskRunWithSnapshot(
  slackThreadTs: string,
  taskId?: string,
) {
  slackDebug(
    `[findCompletedSlackTaskRunWithSnapshot] Searching for completed task run with snapshot for thread ${slackThreadTs}`,
  );

  // Only consider snapshots that haven't expired yet (7-day TTL).
  const snapshotCutoff = new Date(Date.now() - SANDBOX_SNAPSHOT_EXPIRY_MS);

  const [completedRun] = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      snapshotId: taskRuns.snapshotId,
      actingUserId: taskRuns.actingUserId,
      payload: taskRuns.payload,
      port: taskRuns.port,
      slackThreadTs: tasks.slackThreadTs,
      result: taskRuns.result,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.slackThreadTs, slackThreadTs),
        ...(taskId ? [eq(taskRuns.taskId, taskId)] : []),
        inArray(taskRuns.status, [RunStatus.Completed, RunStatus.Idle]),
        isNotNull(taskRuns.snapshotId),
        isNull(taskRuns.snapshotFailedAt),
        isNull(taskRuns.canceledAt),
        gt(taskRuns.snapshotCreatedAt, snapshotCutoff),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (completedRun) {
    slackDebug(
      `[findCompletedSlackTaskRunWithSnapshot] Found completed task run ${completedRun.id} with snapshot ${completedRun.snapshotId}`,
    );
    return completedRun;
  }

  slackDebug(
    `[findCompletedSlackTaskRunWithSnapshot] No completed task run with snapshot found for thread ${slackThreadTs}`,
  );
  return null;
}

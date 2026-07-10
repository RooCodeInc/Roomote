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
 *
 * Returns the run row needed to construct a SnapshotResume launch, or null
 * if no suitable run exists.
 */
export async function findCompletedSlackJobWithSnapshot(slackThreadTs: string) {
  slackDebug(
    `[findCompletedSlackJobWithSnapshot] Searching for completed job with snapshot for thread ${slackThreadTs}`,
  );

  // Only consider snapshots that haven't expired yet (7-day TTL).
  const snapshotCutoff = new Date(Date.now() - SANDBOX_SNAPSHOT_EXPIRY_MS);

  const [completedJob] = await db
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
        inArray(taskRuns.status, [RunStatus.Completed, RunStatus.Idle]),
        isNotNull(taskRuns.snapshotId),
        isNull(taskRuns.snapshotFailedAt),
        isNull(taskRuns.canceledAt),
        gt(taskRuns.snapshotCreatedAt, snapshotCutoff),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (completedJob) {
    slackDebug(
      `[findCompletedSlackJobWithSnapshot] Found completed job ${completedJob.id} with snapshot ${completedJob.snapshotId}`,
    );
    return completedJob;
  }

  slackDebug(
    `[findCompletedSlackJobWithSnapshot] No completed job with snapshot found for thread ${slackThreadTs}`,
  );
  return null;
}

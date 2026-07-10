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

/**
 * Find the most recent completed/idle run for a Linear issue that has a
 * valid snapshot. Used to determine whether a follow-up message can resume
 * from a previous sandbox snapshot instead of starting fresh.
 *
 * Matches by issue ID rather than session ID because Linear creates a new
 * session for each agent mention, even on the same issue. Linear channel
 * bindings live on tasks, so the lookup joins task_runs to tasks.
 *
 * Returns the run row needed to construct a SnapshotResume launch, or null
 * if no suitable run exists.
 */
export async function findCompletedLinearTaskRunWithSnapshot(
  linearIssueId: string,
) {
  console.log(
    `[findCompletedLinearTaskRunWithSnapshot] Searching for completed task run with snapshot for issue ${linearIssueId}`,
  );

  // Only consider snapshots that haven't expired yet (7-day TTL).
  const snapshotCutoff = new Date(Date.now() - SANDBOX_SNAPSHOT_EXPIRY_MS);

  const [completedRun] = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      snapshotId: taskRuns.snapshotId,
      actingUserId: taskRuns.actingUserId,
      linearSessionId: tasks.linearSessionId,
      linearIssueId: tasks.linearIssueId,
      linearOrganizationId: tasks.linearOrganizationId,
      slackThreadTs: tasks.slackThreadTs,
      payload: taskRuns.payload,
      port: taskRuns.port,
      result: taskRuns.result,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.linearIssueId, linearIssueId),
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
    console.log(
      `[findCompletedLinearTaskRunWithSnapshot] Found completed task run ${completedRun.id} with snapshot ${completedRun.snapshotId}`,
    );
    return completedRun;
  }

  console.log(
    `[findCompletedLinearTaskRunWithSnapshot] No completed task run with snapshot found for issue ${linearIssueId}`,
  );
  return null;
}

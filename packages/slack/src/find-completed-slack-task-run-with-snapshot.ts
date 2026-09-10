import {
  db,
  tasks,
  taskRuns,
  eq,
  and,
  inArray,
  isNull,
  isNotNull,
  desc,
  isSnapshotResumableCondition,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

import { slackDebug } from './logging';
import type { SlackTaskRunLookupScope } from './find-active-slack-task-run';
import {
  getSlackTaskRunWorkspacePredicate,
  getSlackTrackedAliasTaskPredicate,
} from './slack-task-run-workspace-scope';

/**
 * Find the most recent completed/idle run for a Slack thread that has a
 * valid snapshot. Used to determine whether a follow-up message can resume
 * from a previous sandbox snapshot instead of starting fresh.
 *
 * Matches by the tasks.slackThreadTs channel binding, which is stable within
 * a single Slack thread (1:N thread-to-task; latest run wins).
 * Callers can add task and workspace scope when the originating action
 * provides those identities.
 *
 * Returns the run row needed to construct a SnapshotResume launch, or null
 * if no suitable run exists.
 */
export async function findCompletedSlackTaskRunWithSnapshot(
  slackThreadTs: string,
  scope: SlackTaskRunLookupScope,
) {
  slackDebug(
    `[findCompletedSlackTaskRunWithSnapshot] Searching for completed task run with snapshot for thread ${slackThreadTs}`,
  );

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
        ...(scope.trackedAlias ? [] : [eq(tasks.slackThreadTs, slackThreadTs)]),
        ...(scope.taskId ? [eq(taskRuns.taskId, scope.taskId)] : []),
        ...(scope.slackTeamId
          ? [getSlackTaskRunWorkspacePredicate(scope.slackTeamId)]
          : []),
        ...(scope.trackedAlias
          ? [
              getSlackTrackedAliasTaskPredicate({
                taskId: scope.taskId,
                ...scope.trackedAlias,
              }),
            ]
          : []),
        inArray(taskRuns.status, [RunStatus.Completed, RunStatus.Idle]),
        isNotNull(taskRuns.snapshotId),
        isNull(taskRuns.snapshotFailedAt),
        isNull(taskRuns.canceledAt),
        isNull(tasks.deletedAt),
        isSnapshotResumableCondition(taskRuns),
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

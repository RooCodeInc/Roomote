import {
  db,
  tasks,
  taskRuns,
  getTableColumns,
  eq,
  and,
  inArray,
  isNull,
  desc,
} from '@roomote/db/server';
import { activeRunStatuses } from '@roomote/types';

import { slackDebug } from './logging';
import { getSlackTaskRunWorkspacePredicate } from './slack-task-run-workspace-scope';

/**
 * Find an active run for a given Slack thread.
 *
 * Slack thread bindings live on tasks (tasks.slackThreadTs, 1:N by design),
 * so this joins task_runs to tasks and returns the most recent non-terminal
 * run across all tasks bound to the thread ("latest task run in thread" plurality
 * semantics -- no unique-thread assumption). Every lookup must include
 * workspace identity or an immutable task binding; a bare thread timestamp is
 * not globally unique across Slack workspaces.
 *
 * Slack follow-up delivery is keyed by run ID, so the webhook can queue
 * messages as soon as the run exists instead of waiting for the worker
 * machine to finish booting.
 */
export type SlackTaskRunLookupScope =
  | { slackTeamId: string; taskId?: string }
  | { taskId: string; slackTeamId?: string };

export async function findActiveSlackTaskRun(
  slackThreadTs: string,
  scope: SlackTaskRunLookupScope,
) {
  slackDebug(
    `[findActiveSlackTaskRun] Searching for active task run in thread ${slackThreadTs}`,
  );

  const [activeRun] = await db
    .select(getTableColumns(taskRuns))
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.slackThreadTs, slackThreadTs),
        ...(scope.taskId ? [eq(taskRuns.taskId, scope.taskId)] : []),
        ...(scope.slackTeamId
          ? [getSlackTaskRunWorkspacePredicate(scope.slackTeamId)]
          : []),
        inArray(taskRuns.status, [...activeRunStatuses]),
        isNull(taskRuns.canceledAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (activeRun) {
    slackDebug(
      `[findActiveSlackTaskRun] Found active task run ${activeRun.id} (status: ${activeRun.status}, machine: ${activeRun.machineId}, task: ${activeRun.taskId})`,
    );
  } else {
    slackDebug(
      `[findActiveSlackTaskRun] No active task run found for thread ${slackThreadTs}`,
    );

    // Diagnostic: query the latest run in this thread regardless of status
    // so we can tell if the run exists but moved to a terminal state.
    const [latestRun] = await db
      .select({
        id: taskRuns.id,
        status: taskRuns.status,
        machineId: taskRuns.machineId,
        taskId: taskRuns.taskId,
        createdAt: taskRuns.createdAt,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(
          eq(tasks.slackThreadTs, slackThreadTs),
          ...(scope.taskId ? [eq(taskRuns.taskId, scope.taskId)] : []),
          ...(scope.slackTeamId
            ? [getSlackTaskRunWorkspacePredicate(scope.slackTeamId)]
            : []),
        ),
      )
      .orderBy(desc(taskRuns.createdAt))
      .limit(1);

    if (latestRun) {
      slackDebug(
        `[findActiveSlackTaskRun] Latest task run in thread ${slackThreadTs}: id=${latestRun.id} status=${latestRun.status} machineId=${latestRun.machineId ?? 'null'} taskId=${latestRun.taskId ?? 'null'} createdAt=${latestRun.createdAt}`,
      );
    } else {
      slackDebug(
        `[findActiveSlackTaskRun] No task runs at all found for thread ${slackThreadTs}`,
      );
    }
  }

  return activeRun ?? null;
}

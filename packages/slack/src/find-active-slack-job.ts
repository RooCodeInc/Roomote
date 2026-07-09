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
import { activeCloudTaskStatuses } from '@roomote/types';

import { slackDebug } from './logging';

/**
 * Find an active run for a given Slack thread.
 *
 * Slack thread bindings live on tasks (tasks.slackThreadTs, 1:N by design),
 * so this joins task_runs to tasks and returns the most recent non-terminal
 * run across all tasks bound to the thread ("latest job in thread" plurality
 * semantics -- no unique-thread assumption).
 *
 * Slack follow-up delivery is keyed by run ID, so the webhook can queue
 * messages as soon as the run exists instead of waiting for the worker
 * machine to finish booting.
 */
export async function findActiveSlackJob(slackThreadTs: string) {
  slackDebug(
    `[findActiveSlackJob] Searching for active job in thread ${slackThreadTs}`,
  );

  const [activeJob] = await db
    .select(getTableColumns(taskRuns))
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.slackThreadTs, slackThreadTs),
        inArray(taskRuns.status, [...activeCloudTaskStatuses]),
        isNull(taskRuns.canceledAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (activeJob) {
    slackDebug(
      `[findActiveSlackJob] Found active job ${activeJob.id} (status: ${activeJob.status}, machine: ${activeJob.machineId}, task: ${activeJob.taskId})`,
    );
  } else {
    slackDebug(
      `[findActiveSlackJob] No active job found for thread ${slackThreadTs}`,
    );

    // Diagnostic: query the latest run in this thread regardless of status
    // so we can tell if the run exists but moved to a terminal state.
    const [latestJob] = await db
      .select({
        id: taskRuns.id,
        status: taskRuns.status,
        machineId: taskRuns.machineId,
        taskId: taskRuns.taskId,
        createdAt: taskRuns.createdAt,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(eq(tasks.slackThreadTs, slackThreadTs))
      .orderBy(desc(taskRuns.createdAt))
      .limit(1);

    if (latestJob) {
      slackDebug(
        `[findActiveSlackJob] Latest job in thread ${slackThreadTs}: id=${latestJob.id} status=${latestJob.status} machineId=${latestJob.machineId ?? 'null'} taskId=${latestJob.taskId ?? 'null'} createdAt=${latestJob.createdAt}`,
      );
    } else {
      slackDebug(
        `[findActiveSlackJob] No jobs at all found for thread ${slackThreadTs}`,
      );
    }
  }

  return activeJob ?? null;
}

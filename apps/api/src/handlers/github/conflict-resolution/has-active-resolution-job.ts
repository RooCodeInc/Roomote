import {
  db,
  taskPullRequests,
  taskRuns,
  tasks,
  eq,
  and,
  inArray,
} from '@roomote/db/server';
import { CloudTaskStatus } from '@roomote/types';

import { LOG_PREFIX } from './constants';

/**
 * Check if there's already an active (pending/running) conflict resolution
 * run for the given PR. Prevents duplicate resolution attempts.
 *
 * PR association lives on task_pull_requests (inserted at enqueue for
 * pr_conflict_resolve launches), so the guard is a tasks JOIN
 * task_pull_requests JOIN task_runs lookup.
 */
export async function hasActiveResolutionJob(
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  const activeStatuses = [CloudTaskStatus.Pending, CloudTaskStatus.Running];

  const existing = await db
    .select({ id: taskRuns.id })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflow, 'pr_conflict_resolve'),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
        inArray(taskRuns.status, activeStatuses),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    console.log(
      `${LOG_PREFIX} Active resolution job already exists for ${repoFullName}#${prNumber} — skipping`,
    );
    return true;
  }

  return false;
}

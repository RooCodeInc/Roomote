import {
  db,
  tasks,
  taskRuns,
  eq,
  and,
  inArray,
  isNull,
  desc,
} from '@roomote/db/server';
import { activeCloudTaskStatuses } from '@roomote/types';

import type { ActiveLinearJobResult } from './types';

/** Column subset returned by active-job lookups. */
const ACTIVE_JOB_SELECTION = {
  id: taskRuns.id,
  status: taskRuns.status,
  machineId: taskRuns.machineId,
  taskId: taskRuns.taskId,
  linearSessionId: tasks.linearSessionId,
  linearOrganizationId: tasks.linearOrganizationId,
  result: taskRuns.result,
} as const;

/**
 * Find an active run for a given Linear agent session.
 *
 * Linear channel bindings live on tasks (tasks.linearSessionId /
 * tasks.linearIssueId, 1:N by design), so lookups join task_runs to tasks
 * and return the most recent job that is not yet completed, failed, or
 * canceled. This includes runs in any active state: Pending, Dequeued,
 * Processing, Preparing, Spawning, Connecting, Running, or Idle.
 *
 * When `linearIssueId` is provided the function first tries an
 * exact match by `linearSessionId`. If that yields nothing it falls back to
 * searching by issue, which catches resumed jobs that were created under
 * a different Linear session (Linear generates a new session ID for every
 * @ mention).
 *
 * Note: We don't require machineId or taskId to be set because:
 * - Jobs may be canceled before they're fully started
 * - The machineId may not be set in all deployment environments
 * - We identify jobs by linearSessionId which is unique per session
 */
export async function findActiveLinearJob(
  linearSessionId: string,
  linearIssueId?: string,
): Promise<ActiveLinearJobResult | null> {
  console.log(
    `[findActiveLinearJob] Searching for active job with session ${linearSessionId}`,
  );

  // First: exact match by session ID (current behaviour).
  const [sessionMatch] = await db
    .select(ACTIVE_JOB_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.linearSessionId, linearSessionId),
        inArray(taskRuns.status, [...activeCloudTaskStatuses]),
        isNull(taskRuns.canceledAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (sessionMatch) {
    console.log(
      `[findActiveLinearJob] Found active job ${sessionMatch.id} by session (status: ${sessionMatch.status}, machine: ${sessionMatch.machineId ?? 'none'}, task: ${sessionMatch.taskId ?? 'none'})`,
    );
    return sessionMatch;
  }

  // Fallback: match by issue so we detect resumed jobs from a
  // different session on the same Linear issue.
  if (linearIssueId) {
    console.log(
      `[findActiveLinearJob] No session match – falling back to issue ${linearIssueId}`,
    );

    const [issueMatch] = await db
      .select(ACTIVE_JOB_SELECTION)
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(
          eq(tasks.linearIssueId, linearIssueId),
          inArray(taskRuns.status, [...activeCloudTaskStatuses]),
          isNull(taskRuns.canceledAt),
        ),
      )
      .orderBy(desc(taskRuns.createdAt))
      .limit(1);

    if (issueMatch) {
      console.log(
        `[findActiveLinearJob] Found active job ${issueMatch.id} by issue (status: ${issueMatch.status}, machine: ${issueMatch.machineId ?? 'none'}, task: ${issueMatch.taskId ?? 'none'})`,
      );
      return issueMatch;
    }
  }

  console.log(
    `[findActiveLinearJob] No active job found for session ${linearSessionId}`,
  );
  return null;
}

/**
 * Find an active run by Linear organization ID.
 * Useful for finding any active job in a Linear workspace.
 */
export async function findActiveLinearJobByOrganization(
  linearOrganizationId: string,
): Promise<ActiveLinearJobResult | null> {
  console.log(
    `[findActiveLinearJobByOrganization] Searching for active job in org ${linearOrganizationId}`,
  );

  const [activeJob] = await db
    .select(ACTIVE_JOB_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.linearOrganizationId, linearOrganizationId),
        inArray(taskRuns.status, [...activeCloudTaskStatuses]),
        isNull(taskRuns.canceledAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (activeJob) {
    console.log(
      `[findActiveLinearJobByOrganization] Found active job ${activeJob.id} (status: ${activeJob.status}, machine: ${activeJob.machineId ?? 'none'})`,
    );
    return activeJob;
  }

  console.log(
    `[findActiveLinearJobByOrganization] No active job found for org ${linearOrganizationId}`,
  );
  return null;
}

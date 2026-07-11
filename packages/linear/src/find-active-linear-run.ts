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
import { activeRunStatuses } from '@roomote/types';

import type { ActiveLinearTaskRunResult } from './types';

/** Column subset returned by active-run lookups. */
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
 * and return the most recent task run that is not yet completed, failed, or
 * canceled. This includes runs in any active state: Pending, Dequeued,
 * Processing, Preparing, Spawning, Connecting, Running, or Idle.
 *
 * When `linearIssueId` is provided the function first tries an
 * exact match by `linearSessionId`. If that yields nothing it falls back to
 * searching by issue, which catches resumed task runs that were created under
 * a different Linear session (Linear generates a new session ID for every
 * @ mention).
 *
 * Note: We don't require machineId or taskId to be set because:
 * - Task runs may be canceled before they're fully started
 * - The machineId may not be set in all deployment environments
 * - We identify task runs by linearSessionId which is unique per session
 */
export async function findActiveLinearTaskRun(
  linearSessionId: string,
  linearIssueId?: string,
): Promise<ActiveLinearTaskRunResult | null> {
  console.log(
    `[findActiveLinearTaskRun] Searching for active task run with session ${linearSessionId}`,
  );

  // First: exact match by session ID (current behaviour).
  const [sessionMatch] = await db
    .select(ACTIVE_JOB_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.linearSessionId, linearSessionId),
        inArray(taskRuns.status, [...activeRunStatuses]),
        isNull(taskRuns.canceledAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (sessionMatch) {
    console.log(
      `[findActiveLinearTaskRun] Found active task run ${sessionMatch.id} by session (status: ${sessionMatch.status}, machine: ${sessionMatch.machineId ?? 'none'}, task: ${sessionMatch.taskId ?? 'none'})`,
    );
    return sessionMatch;
  }

  // Fallback: match by issue so we detect resumed task runs from a
  // different session on the same Linear issue.
  if (linearIssueId) {
    console.log(
      `[findActiveLinearTaskRun] No session match – falling back to issue ${linearIssueId}`,
    );

    const [issueMatch] = await db
      .select(ACTIVE_JOB_SELECTION)
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(
          eq(tasks.linearIssueId, linearIssueId),
          inArray(taskRuns.status, [...activeRunStatuses]),
          isNull(taskRuns.canceledAt),
        ),
      )
      .orderBy(desc(taskRuns.createdAt))
      .limit(1);

    if (issueMatch) {
      console.log(
        `[findActiveLinearTaskRun] Found active task run ${issueMatch.id} by issue (status: ${issueMatch.status}, machine: ${issueMatch.machineId ?? 'none'}, task: ${issueMatch.taskId ?? 'none'})`,
      );
      return issueMatch;
    }
  }

  console.log(
    `[findActiveLinearTaskRun] No active task run found for session ${linearSessionId}`,
  );
  return null;
}

/**
 * Find an active run by Linear organization ID.
 * Useful for finding any active task run in a Linear workspace.
 */
export async function findActiveLinearTaskRunByOrganization(
  linearOrganizationId: string,
): Promise<ActiveLinearTaskRunResult | null> {
  console.log(
    `[findActiveLinearTaskRunByOrganization] Searching for active task run in org ${linearOrganizationId}`,
  );

  const [activeRun] = await db
    .select(ACTIVE_JOB_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.linearOrganizationId, linearOrganizationId),
        inArray(taskRuns.status, [...activeRunStatuses]),
        isNull(taskRuns.canceledAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (activeRun) {
    console.log(
      `[findActiveLinearTaskRunByOrganization] Found active task run ${activeRun.id} (status: ${activeRun.status}, machine: ${activeRun.machineId ?? 'none'})`,
    );
    return activeRun;
  }

  console.log(
    `[findActiveLinearTaskRunByOrganization] No active task run found for org ${linearOrganizationId}`,
  );
  return null;
}

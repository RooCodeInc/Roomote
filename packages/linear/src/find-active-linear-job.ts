import {
  db,
  cloudJobs,
  eq,
  and,
  inArray,
  isNull,
  desc,
} from '@roomote/db/server';
import { activeCloudTaskStatuses } from '@roomote/types';

import type { ActiveLinearJobResult } from './types';

/** Column subset returned by active-job lookups. */
const ACTIVE_JOB_COLUMNS = {
  id: true,
  status: true,
  machineId: true,
  taskId: true,
  linearSessionId: true,
  linearOrganizationId: true,
  result: true,
} as const;

/**
 * Find an active cloud job for a given Linear agent session.
 *
 * Returns the most recent job that is not yet completed, failed, or canceled.
 * This includes jobs in any active state: Pending, Dequeued, Processing,
 * Preparing, Spawning, Connecting, Running, or Idle.
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
  const sessionMatch = await db.query.cloudJobs.findFirst({
    where: and(
      eq(cloudJobs.linearSessionId, linearSessionId),
      inArray(cloudJobs.status, [...activeCloudTaskStatuses]),
      isNull(cloudJobs.canceledAt),
    ),
    orderBy: desc(cloudJobs.createdAt),
    columns: ACTIVE_JOB_COLUMNS,
  });

  if (sessionMatch) {
    console.log(
      `[findActiveLinearJob] Found active job ${sessionMatch.id} by session (status: ${sessionMatch.status}, machine: ${sessionMatch.machineId ?? 'none'}, task: ${sessionMatch.taskId ?? 'none'})`,
    );
    return sessionMatch as ActiveLinearJobResult;
  }

  // Fallback: match by issue so we detect resumed jobs from a
  // different session on the same Linear issue.
  if (linearIssueId) {
    console.log(
      `[findActiveLinearJob] No session match – falling back to issue ${linearIssueId}`,
    );

    const issueMatch = await db.query.cloudJobs.findFirst({
      where: and(
        eq(cloudJobs.linearIssueId, linearIssueId),
        inArray(cloudJobs.status, [...activeCloudTaskStatuses]),
        isNull(cloudJobs.canceledAt),
      ),
      orderBy: desc(cloudJobs.createdAt),
      columns: ACTIVE_JOB_COLUMNS,
    });

    if (issueMatch) {
      console.log(
        `[findActiveLinearJob] Found active job ${issueMatch.id} by issue (status: ${issueMatch.status}, machine: ${issueMatch.machineId ?? 'none'}, task: ${issueMatch.taskId ?? 'none'})`,
      );
      return issueMatch as ActiveLinearJobResult;
    }
  }

  console.log(
    `[findActiveLinearJob] No active job found for session ${linearSessionId}`,
  );
  return null;
}

/**
 * Find an active cloud job by Linear organization ID.
 * Useful for finding any active job in a Linear workspace.
 */
export async function findActiveLinearJobByOrganization(
  linearOrganizationId: string,
): Promise<ActiveLinearJobResult | null> {
  console.log(
    `[findActiveLinearJobByOrganization] Searching for active job in org ${linearOrganizationId}`,
  );

  const activeJob = await db.query.cloudJobs.findFirst({
    where: and(
      eq(cloudJobs.linearOrganizationId, linearOrganizationId),
      inArray(cloudJobs.status, [...activeCloudTaskStatuses]),
      isNull(cloudJobs.canceledAt),
    ),
    orderBy: desc(cloudJobs.createdAt),
    columns: ACTIVE_JOB_COLUMNS,
  });

  if (activeJob) {
    console.log(
      `[findActiveLinearJobByOrganization] Found active job ${activeJob.id} (status: ${activeJob.status}, machine: ${activeJob.machineId ?? 'none'})`,
    );
    return activeJob as ActiveLinearJobResult;
  }

  console.log(
    `[findActiveLinearJobByOrganization] No active job found for org ${linearOrganizationId}`,
  );
  return null;
}

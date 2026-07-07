import { db, cloudJobs, eq, and, inArray } from '@roomote/db/server';
import { CloudTaskType, CloudTaskStatus } from '@roomote/types';

import { LOG_PREFIX } from './constants';

/**
 * Check if there's already an active (pending/running) conflict resolution
 * job for the given PR. Prevents duplicate resolution attempts.
 */
export async function hasActiveResolutionJob(
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  const activeStatuses = [CloudTaskStatus.Pending, CloudTaskStatus.Running];

  const existing = await db
    .select({ id: cloudJobs.id })
    .from(cloudJobs)
    .where(
      and(
        eq(cloudJobs.type, CloudTaskType.GithubPrConflictResolve),
        eq(cloudJobs.prRepo, repoFullName),
        eq(cloudJobs.prNumber, prNumber),
        inArray(cloudJobs.status, activeStatuses),
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

import type { JobTokenContext } from '@roomote/types';
import { db, cloudJobs, eq } from '@roomote/db/server';

export const findCloudJob = async (id: number) =>
  db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, id),
  });

/**
 * Narrow status snapshot for worker polling loops (cancel checks, sleep
 * handoff, snapshot waits). These poll every few seconds per active sandbox,
 * so they must not fetch the full row — `payload`, `prompt`, `result`, and
 * other large columns turn each poll into an expensive read under load.
 */
export const findCloudJobRuntimeState = async (id: number) =>
  db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, id),
    columns: {
      id: true,
      status: true,
      taskPhase: true,
      canceledAt: true,
      sleepAt: true,
      sleepRequestedAt: true,
      snapshotCreatedAt: true,
      snapshotFailedAt: true,
      error: true,
    },
  });

export const findCloudJobForAccess = async (id: number) =>
  db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, id),
    columns: { id: true },
  });

export const findCloudJobByJobTokenClaims = async ({
  cloudJobId,
  userId,
}: Pick<JobTokenContext, 'cloudJobId' | 'userId'>) => {
  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, cloudJobId),
    columns: { id: true, userId: true },
  });

  if (!cloudJob) {
    return null;
  }

  if (cloudJob.userId && cloudJob.userId !== userId) {
    return null;
  }

  return { id: cloudJob.id };
};

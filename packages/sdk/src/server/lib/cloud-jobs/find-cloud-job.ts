import type { JobTokenContext } from '@roomote/types';
import { db, taskRuns, eq } from '@roomote/db/server';

export const findCloudJob = async (id: number) =>
  db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, id),
  });

/**
 * Narrow status snapshot for worker polling loops (cancel checks, sleep
 * handoff, snapshot waits). These poll every few seconds per active sandbox,
 * so they must not fetch the full row — `payload`, `prompt`, `result`, and
 * other large columns turn each poll into an expensive read under load.
 */
export const findCloudJobRuntimeState = async (id: number) =>
  db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, id),
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
  db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, id),
    columns: { id: true },
  });

export const findCloudJobByJobTokenClaims = async ({
  cloudJobId,
  userId,
}: Pick<JobTokenContext, 'cloudJobId' | 'userId'>) => {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, cloudJobId),
    columns: { id: true, actingUserId: true },
  });

  if (!run) {
    return null;
  }

  // Token/run match rule: (run.actingUserId ?? null) === token.userId.
  // null === null is a valid deployment-principal match.
  if ((run.actingUserId ?? null) !== (userId ?? null)) {
    return null;
  }

  return { id: run.id };
};

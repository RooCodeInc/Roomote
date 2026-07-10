import type { RunTokenContext } from '@roomote/types';
import { db, taskRuns, eq } from '@roomote/db/server';

export const findTaskRun = async (id: number) =>
  db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, id),
  });

/**
 * Narrow status snapshot for worker polling loops (cancel checks, sleep
 * handoff, snapshot waits). These poll every few seconds per active sandbox,
 * so they must not fetch the full row — `payload`, `prompt`, `result`, and
 * other large columns turn each poll into an expensive read under load.
 */
export const findTaskRunRuntimeState = async (id: number) =>
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

export const findTaskRunForAccess = async (id: number) =>
  db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, id),
    columns: { id: true },
  });

/**
 * Resolve the run a run token is bound to. The token's `runId` binding IS
 * the authorization: only that run's sandbox holds the token, so no principal
 * equality against `task_runs.actingUserId` is performed. The token's userId
 * is mint-time attribution while actingUserId is current-steering attribution
 * — web steer and follow-up delivery mutate the acting user mid-run, so the
 * two legitimately diverge and must not be compared for authorization.
 */
export const findTaskRunByRunTokenClaims = async ({
  runId,
}: Pick<RunTokenContext, 'runId'>) => {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { id: true },
  });

  return run ? { id: run.id } : null;
};

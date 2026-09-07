import { db, eq, getTaskHumanOwnerUserIds, taskRuns } from '@roomote/db/server';

interface ActorScopedAuthContext {
  /**
   * Null when the token runs as the deployment service principal (no human);
   * such contexts resolve to "no acting user".
   */
  userId?: string | null;
  runId?: number;
}

export interface ActorScopedUserContext {
  userId?: string;
}

/**
 * Resolve the effective human for actor-scoped integration lookups.
 *
 * Run tokens are authorized by their run-scoped `runId` binding; the
 * token's userId is only mint-time attribution. Live-task steers and
 * follow-ups switch `task_runs.actingUserId` to the latest human who is
 * speaking to the task, so actor-scoped integration lookups follow that
 * live value when present, then the token's mint-time user, then the trusted
 * human owner persisted on the task's canonical Session.
 *
 * Because this PREFERS the live `actingUserId`, that column is a credential-
 * resolution input and must only ever be written by trusted server-side
 * actors (web steer, follow-up delivery). Run-scoped run tokens — which the
 * sandbox holds — cannot write it: `taskRuns.update` strips `actingUserId`
 * from run-token input, closing the confused-deputy path where a compromised
 * sandbox reassigns the run to a victim and reads that victim's credentials.
 */
export async function resolveActorScopedUserContext(
  auth: ActorScopedAuthContext | null | undefined,
): Promise<ActorScopedUserContext> {
  if (!auth) {
    return {};
  }

  const fallback = {
    userId: auth.userId ?? undefined,
  };

  if (!auth.runId) {
    return fallback;
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: {
      actingUserId: true,
      taskId: true,
    },
    where: eq(taskRuns.id, auth.runId),
  });

  if (!taskRun) {
    return fallback;
  }

  const liveUserId = taskRun.actingUserId ?? auth.userId ?? undefined;
  if (liveUserId) {
    return { userId: liveUserId };
  }

  const [ownerUserId] = await getTaskHumanOwnerUserIds(db, taskRun.taskId);
  return { userId: ownerUserId };
}

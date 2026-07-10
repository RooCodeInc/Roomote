import { db, eq, taskRuns } from '@roomote/db/server';

interface ActorScopedAuthContext {
  /**
   * Null when the token runs as the deployment service principal (no human);
   * such contexts resolve to "no acting user".
   */
  userId?: string | null;
  cloudJobId?: number;
}

export interface ActorScopedUserContext {
  userId?: string;
}

/**
 * Resolve the effective human for actor-scoped integration lookups.
 *
 * Job tokens are authorized by their run-scoped `cloudJobId` binding; the
 * token's userId is only mint-time attribution. Live-task steers and
 * follow-ups switch `task_runs.actingUserId` to the latest human who is
 * speaking to the task, so actor-scoped integration lookups follow that
 * live value when present and fall back to the token's mint-time user.
 *
 * Because this PREFERS the live `actingUserId`, that column is a credential-
 * resolution input and must only ever be written by trusted server-side
 * actors (web steer, follow-up delivery). Run-scoped job tokens — which the
 * sandbox holds — cannot write it: `cloudJobs.update` strips `actingUserId`
 * from job-token input, closing the confused-deputy path where a compromised
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

  if (!auth.cloudJobId) {
    return fallback;
  }

  const cloudJob = await db.query.taskRuns.findFirst({
    columns: {
      actingUserId: true,
    },
    where: eq(taskRuns.id, auth.cloudJobId),
  });

  if (!cloudJob) {
    return fallback;
  }

  return {
    userId: cloudJob.actingUserId ?? auth.userId ?? undefined,
  };
}

import { cloudJobs, db, eq } from '@roomote/db/server';

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
 * Job tokens stay authorized as the original job owner, but live-task
 * follow-ups may switch `cloud_jobs.actingUserId` to the latest human who is
 * speaking to the task. Actor-scoped integration lookups should follow that
 * override when present.
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

  const cloudJob = await db.query.cloudJobs.findFirst({
    columns: {
      userId: true,
      actingUserId: true,
    },
    where: eq(cloudJobs.id, auth.cloudJobId),
  });

  if (!cloudJob) {
    return fallback;
  }

  return {
    userId:
      cloudJob.actingUserId ?? cloudJob.userId ?? auth.userId ?? undefined,
  };
}

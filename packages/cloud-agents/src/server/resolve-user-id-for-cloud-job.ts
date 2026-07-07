import type { CloudJob } from '@roomote/db';
import { db, asc, isNull, users } from '@roomote/db/server';

/**
 * Resolves the user ID that should be associated with a cloud job for
 * authentication purposes (e.g., job tokens, GitHub tokens).
 *
 * Prefers `userId` (the user who created the job), then falls back to the
 * first active deployment user for integration-triggered jobs that predate a
 * user mapping.
 *
 * @returns The resolved user ID, or `null` if no user could be determined.
 */
export async function resolveUserIdForCloudJob(
  cloudJob: Pick<CloudJob, 'id' | 'userId'>,
): Promise<string | null> {
  if (cloudJob.userId) {
    return cloudJob.userId;
  }

  const user = await db.query.users.findFirst({
    where: isNull(users.deletedAt),
    // Keep the fallback stable so tokens minted earlier in the job lifecycle resolve
    // to the same user during later auth checks.
    orderBy: [asc(users.id)],
  });

  return user?.id ?? null;
}

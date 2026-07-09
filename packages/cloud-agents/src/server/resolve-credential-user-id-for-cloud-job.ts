import type { CloudJob } from '@roomote/db';
import { db, asc, isNull, users } from '@roomote/db/server';

/**
 * Resolves the user whose credentials a cloud job should use for
 * authentication purposes (e.g. job tokens, GitHub tokens, MCP OAuth
 * lookups).
 *
 * This is credential plumbing, never attribution: task/analytics attribution
 * comes from the attribution snapshot columns (`attributionKind`,
 * `attributedUserId`, `attributionSourceDisplayName`), and automation-initiated
 * jobs intentionally carry a null `userId`.
 *
 * Prefers `userId` (the human who created the job) and falls back to the
 * first active deployment user for automation-initiated jobs and
 * integration-triggered jobs that predate a user mapping. Callers that track a
 * live human actor should prefer `cloudJobs.actingUserId` before calling this.
 *
 * @returns The resolved user ID, or `null` if no user could be determined.
 */
export async function resolveCredentialUserIdForCloudJob(
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

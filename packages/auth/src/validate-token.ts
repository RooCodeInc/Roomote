import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import { validateAuthToken } from './auth-token';
import { validateJobToken } from './job-token';

/**
 * Validates a token that may be either a job token (`cj`) or an auth token (`auth`).
 *
 * During the migration to job-scoped tokens, both token types need to be accepted
 * by the sandbox server. This function tries `validateJobToken` first (since job
 * tokens are the preferred type for worker contexts), then falls back to
 * `validateAuthToken`.
 *
 * Once all callers have migrated to job tokens, this function can be removed and
 * replaced with a direct call to `validateJobToken`.
 */
export async function validateToken(
  token: string,
): Promise<JobTokenContext | AuthTokenContext> {
  let jobTokenError: unknown;

  try {
    return await validateJobToken(token);
  } catch (error) {
    jobTokenError = error;
  }

  try {
    return await validateAuthToken(token);
  } catch (authTokenError) {
    const jobMsg =
      jobTokenError instanceof Error
        ? jobTokenError.message
        : String(jobTokenError);

    const authMsg =
      authTokenError instanceof Error
        ? authTokenError.message
        : String(authTokenError);

    throw new Error(
      `Token validation failed (job: ${jobMsg}; auth: ${authMsg})`,
    );
  }
}

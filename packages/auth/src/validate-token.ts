import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import { validateAuthToken } from './auth-token';
import { validateRunToken } from './run-token';

/**
 * Validates a token that may be either a run token (`run`) or an auth token (`auth`).
 *
 * During the migration to run-scoped tokens, both token types need to be accepted
 * by the sandbox server. This function tries `validateRunToken` first (since run
 * tokens are the preferred type for worker contexts), then falls back to
 * `validateAuthToken`.
 *
 * Once all callers have migrated to run tokens, this function can be removed and
 * replaced with a direct call to `validateRunToken`.
 */
export async function validateToken(
  token: string,
): Promise<RunTokenContext | AuthTokenContext> {
  let runTokenError: unknown;

  try {
    return await validateRunToken(token);
  } catch (error) {
    runTokenError = error;
  }

  try {
    return await validateAuthToken(token);
  } catch (authTokenError) {
    const runMsg =
      runTokenError instanceof Error
        ? runTokenError.message
        : String(runTokenError);

    const authMsg =
      authTokenError instanceof Error
        ? authTokenError.message
        : String(authTokenError);

    throw new Error(
      `Token validation failed (run: ${runMsg}; auth: ${authMsg})`,
    );
  }
}

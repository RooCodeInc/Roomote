import { resolveDeploymentEnvVar } from '@roomote/db/server';

import {
  getConfiguredGitHubAppSlugCache,
  getEffectiveGitHubAppSlug,
  setConfiguredGitHubAppSlugCache,
} from './app-slug';

// Non-empty values are cached briefly to avoid a decrypting DB read on every
// webhook delivery; misses are not cached so a slug saved by the /setup
// manifest flow is picked up immediately (same policy as the webhook secret
// resolution in the api webhook route).
const CONFIGURED_APP_SLUG_CACHE_TTL_MS = 60_000;

/**
 * Resolves the deployment's configured GitHub App slug through the deployment
 * env layer (process env, then the encrypted environment_variables table) and
 * caches it for the synchronous identity helpers (`isRoomoteGitHubLogin`,
 * mention detection). Identity-sensitive paths await this before classifying
 * logins so a deployment whose app was created through the /setup flow — and
 * therefore has no slug in the process environment — still recognizes its own
 * bot. Falls back to the last cached or process-env value when the database
 * is unavailable.
 */
export async function resolveConfiguredGitHubAppSlug(): Promise<string> {
  const cache = getConfiguredGitHubAppSlugCache();

  if (cache?.value && cache.expiresAt > Date.now()) {
    return getEffectiveGitHubAppSlug();
  }

  try {
    const slug = await resolveDeploymentEnvVar('R_GITHUB_APP_SLUG');

    setConfiguredGitHubAppSlugCache({
      value: slug,
      expiresAt: Date.now() + CONFIGURED_APP_SLUG_CACHE_TTL_MS,
    });
  } catch (error) {
    console.warn(
      `[resolveConfiguredGitHubAppSlug] falling back to the last known app slug: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return getEffectiveGitHubAppSlug();
}

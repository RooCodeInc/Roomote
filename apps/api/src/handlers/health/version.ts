import { Env } from '@roomote/env';

/**
 * Resolve the running app version for health diagnostics.
 *
 * Prefers the release tag baked into published app images, then falls back to
 * the commit SHA sources used by the API's Sentry release resolution
 * (monitoring/sentry.ts), and finally to 'development' for local builds.
 */
export function resolveAppVersion(): string {
  return (
    Env.RELEASE_VERSION?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    'development'
  );
}

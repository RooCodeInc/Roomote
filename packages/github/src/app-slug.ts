import { Env, isEnvFlagEnabled } from '@roomote/env';

/**
 * Cached result of resolving the deployment's configured GitHub App slug
 * through the deployment env layer. `value: null` records that resolution ran
 * and found nothing configured; a `null` cache means resolution has not run
 * in this process yet. Lives in its own module so the synchronous identity
 * helpers stay free of database imports.
 */
export type ConfiguredGitHubAppSlugCache = {
  value: string | null;
  expiresAt: number;
};

let configuredAppSlugCache: ConfiguredGitHubAppSlugCache | null = null;

export function getConfiguredGitHubAppSlugCache(): ConfiguredGitHubAppSlugCache | null {
  return configuredAppSlugCache;
}

export function setConfiguredGitHubAppSlugCache(
  cache: ConfiguredGitHubAppSlugCache | null,
): void {
  configuredAppSlugCache = cache;
}

/**
 * The deployment's GitHub App slug: the configured value when one has been
 * resolved (see `resolveConfiguredGitHubAppSlug`), otherwise the process-env
 * value with its hosted-product default. An expired cache entry is still
 * preferred over the default — the configured slug only changes when an
 * operator re-runs the GitHub App setup, and the stale value beats
 * misclassifying the deployment's own bot login.
 */
export function getEffectiveGitHubAppSlug(): string {
  return configuredAppSlugCache?.value ?? Env.R_GITHUB_APP_SLUG;
}
/**
 * Whether this deployment answers (and advertises) the canonical `@roomote`
 * mention alias in addition to its own app slug. Disable with
 * `R_GITHUB_DISABLE_CANONICAL_MENTION=true` when several deployments share
 * the same repositories and a bare `@roomote` would make all of them respond.
 */
export function isCanonicalGitHubMentionEnabled(): boolean {
  return !isEnvFlagEnabled(Env.R_GITHUB_DISABLE_CANONICAL_MENTION);
}

import { Env } from '@roomote/env';

/**
 * Comma-separated list of repository full names (e.g. "owner/repo") that
 * should be skipped for automated GitHub processing.
 *
 * The value comes from the optional `R_GITHUB_AUTOMATED_SKIP_REPOS` env var.
 */
const skippedRepos: Set<string> = new Set(
  (Env.R_GITHUB_AUTOMATED_SKIP_REPOS ?? '')
    .split(',')
    .map((repo) => repo.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Comma-separated list of repository owners (e.g. "Roomote") whose repos
 * should be skipped for automated GitHub processing.
 *
 * The value comes from the optional `R_GITHUB_AUTOMATED_SKIP_OWNERS` env var.
 */
const skippedOwners: Set<string> = new Set(
  (Env.R_GITHUB_AUTOMATED_SKIP_OWNERS ?? '')
    .split(',')
    .map((owner) => owner.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Returns `true` when the given repository should be skipped for
 * automated GitHub processing.
 */
export function isRepoSkipped(repoFullName: string): boolean {
  const normalizedRepoFullName = repoFullName.toLowerCase();

  if (skippedRepos.has(normalizedRepoFullName)) {
    return true;
  }

  const [owner] = normalizedRepoFullName.split('/');

  return Boolean(owner && skippedOwners.has(owner));
}

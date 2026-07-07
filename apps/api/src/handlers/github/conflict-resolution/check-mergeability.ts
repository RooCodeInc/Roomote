import type { OctokitClient } from './types';

import { MERGEABILITY_MAX_ATTEMPTS, LOG_PREFIX } from './constants';

type MergeabilityResult =
  | { status: 'clean' }
  | { status: 'conflicting' }
  | { status: 'unknown' };

/**
 * Check if a PR currently has merge conflicts.
 *
 * GitHub computes mergeability asynchronously after pushes, so the
 * `mergeable` field may be `null` on the first request. This function
 * performs a single check — the caller is responsible for retry scheduling.
 */
export async function checkMergeability(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<MergeabilityResult> {
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (pr.mergeable === null) {
      return { status: 'unknown' };
    }

    if (pr.mergeable) {
      return { status: 'clean' };
    }

    // mergeable === false → conflicts exist
    return { status: 'conflicting' };
  } catch (error) {
    console.error(
      `${LOG_PREFIX} checkMergeability failed for ${owner}/${repo}#${prNumber}:`,
      error instanceof Error ? error.message : error,
    );
    return { status: 'unknown' };
  }
}

/**
 * Poll mergeability with exponential back-off.
 *
 * Returns the final result once mergeability is resolved or the retry
 * budget is exhausted.
 */
export async function pollMergeability(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  maxAttempts = MERGEABILITY_MAX_ATTEMPTS,
): Promise<MergeabilityResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await checkMergeability(octokit, owner, repo, prNumber);

    if (result.status !== 'unknown') {
      return result;
    }

    if (attempt < maxAttempts) {
      // Simple delay: 15s, 30s, 45s, 60s capped
      const pollDelay = Math.min(attempt * 15_000, 60_000);

      console.log(
        `${LOG_PREFIX} Mergeability unknown for ${owner}/${repo}#${prNumber}, retrying in ${pollDelay / 1000}s (attempt ${attempt}/${maxAttempts})`,
      );

      await new Promise((resolve) => setTimeout(resolve, pollDelay));
    }
  }

  console.warn(
    `${LOG_PREFIX} Mergeability still unknown after ${maxAttempts} attempts for ${owner}/${repo}#${prNumber}`,
  );

  return { status: 'unknown' };
}

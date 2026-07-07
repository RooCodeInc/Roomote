import type { OctokitClient } from './types';

import {
  AUTO_RESOLVE_CONFLICTS_LABEL,
  DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS,
  DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
  LOG_PREFIX,
} from './constants';

export interface ConflictCandidate {
  owner: string;
  repo: string;
  prNumber: number;
  headRef: string;
  headSha: string;
  headRepoOwner: string;
  headRepoName: string;
  baseRef: string;
  title: string;
  htmlUrl: string;
  /** GitHub login of the PR author (e.g. "brunobergher"). */
  authorLogin: string;
  /** GitHub user ID of the PR author. */
  authorId: number;
}

/**
 * Discover open PRs (including drafts) that carry the auto-resolve label and
 * were updated within the lookback window.
 *
 * @param octokit  Authenticated Octokit instance for the installation.
 * @param owner    Repository owner (org or user).
 * @param repo     Repository name.
 * @param baseRef  Optional base branch filter (e.g. `main`). When provided
 *                 only PRs targeting that base branch are returned.
 */
export async function discoverCandidates(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  baseRef?: string,
  conflictResolverLabel: string = AUTO_RESOLVE_CONFLICTS_LABEL,
  maxPrAgeDays: number = DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
): Promise<ConflictCandidate[]> {
  const oldestAllowedUpdatedAt = new Date();
  oldestAllowedUpdatedAt.setDate(
    oldestAllowedUpdatedAt.getDate() - DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS,
  );
  const oldestAllowedCreatedAt = new Date();
  oldestAllowedCreatedAt.setDate(
    oldestAllowedCreatedAt.getDate() - maxPrAgeDays,
  );

  try {
    // GitHub Search API: open PRs with the label, updated within the lookback window
    const prs = await octokit.paginate(octokit.rest.pulls.list, {
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      ...(baseRef ? { base: baseRef } : {}),
    });

    const candidates: ConflictCandidate[] = [];

    for (const pr of prs) {
      // Must have the opt-in label
      const hasLabel = pr.labels.some(
        (l: { name?: string }) => l.name === conflictResolverLabel,
      );

      if (!hasLabel) {
        continue;
      }

      // Must be within the lookback window
      const updatedAt = new Date(pr.updated_at);

      if (updatedAt < oldestAllowedUpdatedAt) {
        // PRs are sorted by updated desc — once we pass the window, stop
        break;
      }

      const createdAt = new Date(pr.created_at);

      if (createdAt < oldestAllowedCreatedAt) {
        continue;
      }

      candidates.push({
        owner,
        repo,
        prNumber: pr.number,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        headRepoOwner: pr.head.repo?.owner?.login ?? owner,
        headRepoName: pr.head.repo?.name ?? repo,
        baseRef: pr.base.ref,
        title: pr.title,
        htmlUrl: pr.html_url,
        authorLogin: pr.user?.login ?? 'unknown',
        authorId: pr.user?.id ?? 0,
      });
    }

    console.log(
      `${LOG_PREFIX} Found ${candidates.length} candidate PRs in ${owner}/${repo}`,
    );

    return candidates;
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to discover candidates for ${owner}/${repo}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

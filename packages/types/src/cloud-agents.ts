/** Default user-facing label for a task runner when no specific name applies. */
export const AGENT_DISPLAY_NAME = 'Agent';

/**
 * PrAction - Controls how repository-changing tasks deliver their work:
 * a ready-for-review PR, a draft PR, or a branch push without a PR.
 */
export const prActions = ['create', 'draft', 'push'] as const;

export type PrAction = (typeof prActions)[number];

export const DEFAULT_PR_ACTION: PrAction = 'draft';

export function normalizePrAction(value: unknown): PrAction {
  return prActions.includes(value as PrAction)
    ? (value as PrAction)
    : DEFAULT_PR_ACTION;
}

export interface PrReviewSettings {
  backgroundAgentManaged?: boolean; // Whether these settings are managed by the Background Agents surface.
  enabled?: boolean; // Whether the review workflow should react to GitHub events at all (default: false).
  environmentScope?: 'all' | 'specific'; // Whether to watch all environments or only specific ones (default: 'all').
  environmentIds?: string[]; // Environment IDs when environmentScope is 'specific'.
  authorReviewMode?: 'all' | 'specific' | 'none'; // Which PR authors to review (default: 'all').
  excludedAuthors?: string; // Comma-separated list of GitHub handles to exclude from triggering this workflow.
  reviewAllPullRequestAuthors?: boolean; // Whether to automatically review PRs opened by authors other than Roomote (default: false).
  reviewOnCommit?: boolean; // Whether to automatically review PRs when opened/pushed to (default: true). If false, only @mention triggers review.
  reviewDraftPrs?: boolean; // Whether to automatically review draft PRs (default: true).
  approvePr?: boolean; // Whether to approve PRs after review when no issues found (default: true).
  relayReviewResultsToTask?: boolean; // Whether completed PR reviews should relay results to the canonical DB-linked Roomote task (default: false).
  relayEligibleCreatorIds?: string[]; // Org-scoped Roomote task creator IDs eligible for linked-task review relays when relay is enabled.
}

export const DEFAULT_PR_REVIEW_SETTINGS = {
  backgroundAgentManaged: true,
  enabled: false,
  environmentScope: 'all',
  authorReviewMode: 'all',
  reviewAllPullRequestAuthors: false,
  reviewOnCommit: true,
  reviewDraftPrs: true,
  approvePr: true,
  relayReviewResultsToTask: false,
  relayEligibleCreatorIds: [],
} satisfies PrReviewSettings;

/**
 * RepositoryScope
 */

export const repositoryScopes = ['all', 'specific'] as const;

export type RepositoryScope = (typeof repositoryScopes)[number];

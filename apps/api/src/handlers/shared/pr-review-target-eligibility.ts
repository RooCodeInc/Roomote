import {
  DEFAULT_PR_REVIEW_SETTINGS,
  type PrReviewSettings,
  type SourceControlAutomationWorkflow,
} from '@roomote/types';

export function getPrReviewTargetEligibility(
  workflow: SourceControlAutomationWorkflow,
  settings: PrReviewSettings | null,
  ignoreAuthorPolicy: boolean,
  authorIsRoomoteManaged: boolean | null,
) {
  if (workflow !== 'pr_review') return 'eligible';

  if ((settings?.enabled ?? DEFAULT_PR_REVIEW_SETTINGS.enabled) === false) {
    return 'automation_disabled';
  }

  return !ignoreAuthorPolicy &&
    authorIsRoomoteManaged === false &&
    !(
      settings?.reviewAllPullRequestAuthors ??
      DEFAULT_PR_REVIEW_SETTINGS.reviewAllPullRequestAuthors
    )
    ? 'author_not_allowed'
    : 'eligible';
}

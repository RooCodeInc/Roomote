import { createGitHubToken } from '@roomote/auth';
import { and, db, eq, taskPullRequests } from '@roomote/db/server';
import { getOctokit } from '@roomote/github';

import { splitRepositoryFullName } from './source-control-pull-request-shared';
import { updateTaskPrStatus } from './update-task-pr-status';

type ReviewResult = {
  outcome: string | null;
  findingCount: number | null;
  headSha: string | null;
};

export type MarkRoomotePullRequestReadyResult =
  | 'marked_ready'
  | 'already_ready'
  | 'not_roomote_created'
  | 'review_not_clean'
  | 'pull_request_not_open'
  | 'head_changed';

/**
 * Promotes a Roomote-created GitHub draft after its persisted terminal review
 * result is clean. Live PR state is re-read so webhook retries are idempotent
 * and a newer head cannot be promoted by an older review.
 */
export async function markRoomotePullRequestReadyAfterCleanReview(input: {
  installationId: number;
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
  reviewResult: ReviewResult;
}): Promise<MarkRoomotePullRequestReadyResult> {
  if (
    input.reviewResult.outcome !== 'clean' ||
    (input.reviewResult.findingCount !== null &&
      input.reviewResult.findingCount !== 0) ||
    input.reviewResult.headSha !== input.reviewHeadSha
  ) {
    return 'review_not_clean';
  }

  const association = await db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.sourceControlProvider, 'github'),
      eq(taskPullRequests.repository, input.repository),
      eq(taskPullRequests.prNumber, input.prNumber),
      eq(taskPullRequests.createdByRoomote, true),
    ),
    columns: { id: true },
  });
  if (!association) {
    return 'not_roomote_created';
  }

  const [owner, repo] = splitRepositoryFullName(input.repository, 'github');
  const token = await createGitHubToken({
    type: 'installationId',
    installationId: input.installationId,
  });
  const octokit = getOctokit(token, { retryRateLimits: true });
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: input.prNumber,
  });

  if (pullRequest.state !== 'open') {
    return 'pull_request_not_open';
  }
  if (pullRequest.head.sha !== input.reviewHeadSha) {
    return 'head_changed';
  }
  if (!pullRequest.draft) {
    await updateTaskPrStatus(
      'github',
      input.repository,
      input.prNumber,
      'open',
    );
    return 'already_ready';
  }

  let result: MarkRoomotePullRequestReadyResult = 'marked_ready';
  try {
    await octokit.graphql(
      `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest { isDraft }
        }
      }`,
      { pullRequestId: pullRequest.node_id },
    );
  } catch (error) {
    // The mutation can succeed remotely while its response times out, or race
    // with another delivery processing the same terminal summary.
    const { data: currentPullRequest } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: input.prNumber,
    });
    if (
      currentPullRequest.state !== 'open' ||
      currentPullRequest.draft ||
      currentPullRequest.head.sha !== input.reviewHeadSha
    ) {
      throw error;
    }
    result = 'already_ready';
  }
  await updateTaskPrStatus('github', input.repository, input.prNumber, 'open');
  return result;
}

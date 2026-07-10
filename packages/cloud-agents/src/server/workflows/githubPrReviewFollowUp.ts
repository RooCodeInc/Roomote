import { type GithubPullRequestReviewFollowUpTask } from '@roomote/types';
import type { ResolvedTaskCommitAuthor } from '../commit-author';
import { Env } from '@roomote/env';
import { buildGitHubMentionFollowUpRequest } from '../github-pr-follow-up-context';
import { buildGitHubMentionFollowUpHarnessInstructions } from '../github-message-instructions';

import {
  getPrDetails,
  getTriggeringComment,
  getIssueDetails,
  getDiff,
  getReviewComments,
  getIssueComments,
  getPrReviewCommentId,
} from './utils';
import { Cli as GitHubCli } from '@roomote/github';
import {
  getGitHubLinkedWorkItemsFromClosingIssues,
  mergeLinkedWorkItems,
} from './pr-linked-work-items';
import { standardTask } from './standardTask';

export async function githubPrReviewFollowUp({
  taskSpec,
  gitHubToken,
  taskRunUrl,
  attribution,
  visualProofAutoScreencastEnabled,
  backgroundProofCaptureEnabled,
}: {
  taskSpec: GithubPullRequestReviewFollowUpTask;
  gitHubToken: string;
  taskRunUrl: string;
  attribution?: ResolvedTaskCommitAuthor;
  visualProofAutoScreencastEnabled?: boolean;
  backgroundProofCaptureEnabled?: boolean;
}): Promise<{
  prompt: string;
  harnessInstructions?: string;
  artifacts: Record<string, unknown>;
}> {
  const {
    payload: {
      prNumber,
      repo: fullName,
      commentId,
      commentBody,
      linkedWorkItems: payloadLinkedWorkItems,
    },
  } = taskSpec;

  const params: GitHubCli.FetchParams = { gitHubToken, repo: fullName };
  const prParams: GitHubCli.FetchPrParams = { ...params, prNumber };

  const pr = await GitHubCli.fetchPr(prParams);

  const triggeringComment = await GitHubCli.fetchTriggeringComment({
    ...params,
    commentId,
    commentBody,
  });

  const issueNumber = pr.closingIssuesReferences[0]?.number;

  const issue = issueNumber
    ? await GitHubCli.fetchIssue({ ...params, issueNumber })
    : null;
  const linkedWorkItems = mergeLinkedWorkItems(
    payloadLinkedWorkItems,
    getGitHubLinkedWorkItemsFromClosingIssues({
      closingIssuesReferences: pr.closingIssuesReferences,
      fallbackRepository: fullName,
    }),
  );

  const { diff, changedFiles } = await GitHubCli.fetchDiff(prParams);
  const reviewComments = await GitHubCli.fetchReviewComments(prParams);
  const issueComments = await GitHubCli.fetchIssueComments(prParams);

  const prReviewerCommentId = await getPrReviewCommentId({
    repo: fullName,
    prNumber,
  });

  const prReviewerComment = prReviewerCommentId
    ? await GitHubCli.fetchIssueComment({
        ...params,
        commentId: prReviewerCommentId,
      })
    : undefined;

  const revertCommitBaseUrl = `${Env.ROOMOTE_APP_URL}/revert-commit?repo=${fullName}&prNumber=${prNumber}`;
  const taskContext = {
    repository: fullName,
    pull_request_number: prNumber,
    workflow: 'pr_review',
    pull_request_base_sha: pr.baseRefOid,
    revert_commit_base_url: revertCommitBaseUrl,
    comment_header_starting: '',
    comment_header_completed: '',
    task_link_follow: `[Follow](${taskRunUrl})`,
    task_link_see: `[See task](${taskRunUrl})`,
    pull_request_details: getPrDetails({ fullName, pr }),
    ...(commentId ? { triggering_comment_id: commentId } : {}),
    triggering_comment: getTriggeringComment(triggeringComment),
    ...(prReviewerCommentId
      ? { top_level_review_comment_id: prReviewerCommentId }
      : {}),
    top_level_review_comment: prReviewerComment?.body ?? 'N/A',
    changed_files:
      changedFiles.length > 0
        ? changedFiles.map((file) => `- \`${file}\``).join('\n')
        : 'Unable to determine changed files. Use the appropriate git commands to incrementally view the changed files.',
    linked_issue: getIssueDetails(fullName, issue),
    pull_request_diff: getDiff({
      prNumber,
      repo: fullName,
      diff,
      lineLimit: 5_000,
      charLimit: 100_000,
    }),
    existing_review_comments: getReviewComments(reviewComments),
    issue_comments: getIssueComments(issueComments),
  } satisfies Record<string, string | number | boolean | null | undefined>;

  const prompt = buildGitHubMentionFollowUpRequest({
    commentBody,
    taskContext,
  });

  const standardTaskResult = standardTask({
    description: prompt,
    repo: fullName,
    taskSurface: 'github',
    taskRunUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems,
    visualProofAutoScreencastEnabled,
    backgroundProofCaptureEnabled,
  });

  const mentionFollowUpPolicy = buildGitHubMentionFollowUpHarnessInstructions();
  standardTaskResult.harnessInstructions =
    standardTaskResult.harnessInstructions
      ? `${standardTaskResult.harnessInstructions}\n\n${mentionFollowUpPolicy}`
      : mentionFollowUpPolicy;

  return standardTaskResult;
}

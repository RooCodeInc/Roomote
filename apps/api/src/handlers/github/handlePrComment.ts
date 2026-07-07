import {
  buildGitHubExistingTaskFollowUpMessage,
  buildGitHubRoutingContext,
  enqueueCloudTask,
  getTaskUrl,
  routeGitHubTask,
  resolveUserIdForCloudJob,
} from '@roomote/cloud-agents/server';
import {
  findActiveGitHubPrReviewTask,
  findReusableGitHubPrFollowUpOwner,
} from '@roomote/db/server';
import { getInstallationOctokit } from '@roomote/github';
import { ensureSnapshotResumeGitHubFollowUpFallback } from '@roomote/sdk/server';
import {
  type CloudTaskPayload,
  CloudAgentType,
  CloudTaskStatus,
  CloudTaskType,
  EXPIRED_SNAPSHOT_RESUME_ERROR,
  PRODUCT_NAME,
  type SnapshotResumePromptFallbackTask,
  isActivelyRunningCloudTask,
  isExitedCloudTaskStatus,
  populateSnapshotResumeSlackMetadata,
  isSnapshotResumable,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { findLatestCloudJob } from '../tasks/helpers';
import {
  getTrackedUserDisplayName,
  sendMessageToTask,
  steerMessageToTask,
} from '../tasks/sendMessageToTask';

import type {
  WebhookPullRequestCommentCreated,
  WebhookIssueCommentCreated,
  WebhookPullRequestReviewSubmitted,
} from './types';
import { getGitHubAutomationTargets } from './getGitHubAutomationTargets';
import { isMention } from './isMention';
import { getReviewTaskRelayPayload } from './reviewTaskRelayPayload';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';

type MentionResponseTarget = {
  repositoryFullName: string;
  prNumber: number;
  reviewCommentId?: number;
};

type ReviewCommentSnapshot = {
  id: number;
  body: string;
  path?: string;
  diffHunk?: string;
  userLogin: string;
};

type GitHubPrMentionReplyLink = { kind: 'task'; url: string };

type GitHubPrMentionReplyOutcome =
  | { kind: 'active_follow_up' }
  | { kind: 'active_review' }
  | { kind: 'dedicated_follow_up' }
  | { kind: 'review_started'; count: number; partial: boolean };

type GitHubPrMentionReplyLinkRequest = {
  kind: 'task';
  taskId: string;
  utm: Parameters<typeof getTaskUrl>[0]['utm'];
  warning: string;
};

async function postMentionResponseComment({
  installationId,
  target,
  body,
}: {
  installationId: number;
  target: MentionResponseTarget;
  body: string;
}): Promise<void> {
  const { repositoryFullName, prNumber, reviewCommentId } = target;
  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return;
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });

    if (reviewCommentId) {
      await octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
        {
          owner,
          repo,
          pull_number: prNumber,
          comment_id: reviewCommentId,
          body,
        },
      );

      return;
    }

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to post mention response comment on ${repositoryFullName}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getMentionResponseTarget(
  eventPayload:
    | WebhookPullRequestCommentCreated
    | WebhookIssueCommentCreated
    | WebhookPullRequestReviewSubmitted,
): MentionResponseTarget {
  if ('comment' in eventPayload && 'pull_request' in eventPayload) {
    return {
      repositoryFullName: eventPayload.repository.full_name,
      prNumber: eventPayload.pull_request.number,
      reviewCommentId:
        eventPayload.comment.in_reply_to_id ?? eventPayload.comment.id,
    };
  }

  const prNumber =
    'issue' in eventPayload
      ? eventPayload.issue.number
      : eventPayload.pull_request.number;

  return {
    repositoryFullName: eventPayload.repository.full_name,
    prNumber,
  };
}

function buildReviewerGateMissComment(): string {
  return `I saw the mention, but I could not start work on this PR with the current ${PRODUCT_NAME} GitHub setup.`;
}

function tryBuildGitHubPrMentionReplyLink(
  request: GitHubPrMentionReplyLinkRequest,
): GitHubPrMentionReplyLink | null {
  try {
    return {
      kind: 'task',
      url: getTaskUrl({
        taskId: request.taskId,
        utm: request.utm,
      }),
    };
  } catch (error) {
    console.warn(
      `${request.warning}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return null;
  }
}

function formatGitHubPrMentionReply(
  outcome: GitHubPrMentionReplyOutcome,
  link: GitHubPrMentionReplyLink | null,
): string {
  const replyCopy = (() => {
    switch (outcome.kind) {
      case 'active_follow_up':
        return {
          intro:
            "I'm on it. I routed this request into the existing PR task so follow-up work stays on one Roomote thread for this PR, and I'll keep updates here.",
          taskLinkText: 'See task',
          fallback:
            'I could not generate the task link for the PR comment, but the follow-up was delivered.',
        };
      case 'active_review':
        return {
          intro: 'I found an active PR review already running for this PR.',
          taskLinkText: 'See task',
          fallback:
            'I could not generate the task link for the PR comment, but the review is already in progress.',
        };
      case 'dedicated_follow_up':
        return {
          intro:
            "I'm on it. I started a dedicated PR follow-up task for this request, and I'll keep updates here.",
          taskLinkText: 'See task',
          fallback:
            'I could not generate the task link for the PR comment, but the follow-up task is already running.',
        };
      case 'review_started':
        if (outcome.partial) {
          return {
            intro:
              'I started PR review tasks for part of this request, but at least one reviewer could not be started right now.',
            taskLinkText: 'See one task',
            fallback:
              'I could not generate the task link for the PR comment, but one or more review tasks are already running.',
          };
        }

        return outcome.count === 1
          ? {
              intro: 'I started a PR review task for this request.',
              taskLinkText: 'See task',
              fallback:
                'I could not generate the task link for the PR comment, but the review task is already running.',
            }
          : {
              intro: 'I started PR review tasks for this request.',
              taskLinkText: 'See one task',
              fallback:
                'I could not generate the task link for the PR comment, but the review tasks are already running.',
            };
    }
  })();

  if (!link) {
    return `${replyCopy.intro} ${replyCopy.fallback}`;
  }

  return `${replyCopy.intro} [${replyCopy.taskLinkText}](${link.url})`;
}

function buildDedicatedTaskStartFailedComment(): string {
  return 'I saw the mention, but I could not start the PR follow-up task right now. Please try again in a moment.';
}

function buildReviewTaskStartFailedComment(): string {
  return 'I saw the mention, but I could not start the PR review task right now. Please try again in a moment.';
}

function buildFollowUpSafetyCheckFailedComment(): string {
  return 'I saw the mention, but I could not safely start PR follow-up on this PR right now because I could not verify the active PR branch. Please try again in a moment.';
}

async function fetchReviewCommentSnapshot({
  installationId,
  repositoryFullName,
  commentId,
}: {
  installationId: number;
  repositoryFullName: string;
  commentId: number;
}): Promise<ReviewCommentSnapshot | null> {
  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return null;
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}',
      {
        owner,
        repo,
        comment_id: commentId,
      },
    );
    const comment = response.data as {
      id?: number;
      body?: string;
      path?: string;
      diff_hunk?: string;
      user?: { login?: string };
    };

    if (
      typeof comment.id !== 'number' ||
      typeof comment.body !== 'string' ||
      typeof comment.user?.login !== 'string'
    ) {
      return null;
    }

    return {
      id: comment.id,
      body: comment.body,
      path: typeof comment.path === 'string' ? comment.path : undefined,
      diffHunk:
        typeof comment.diff_hunk === 'string' ? comment.diff_hunk : undefined,
      userLogin: comment.user.login,
    };
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to fetch review comment ${commentId} on ${repositoryFullName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function formatQuotedText(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function formatCompactGitHubIssueComments(
  comments: Array<{ author: string; body: string }>,
): string | undefined {
  if (comments.length === 0) {
    return undefined;
  }

  const recentComments = comments.slice(-10);
  const omittedCount = comments.length - recentComments.length;
  const lines = ['## Top-level Comments', ''];

  for (const comment of recentComments) {
    lines.push(`Top-level comment from @${comment.author}:`);
    lines.push(formatQuotedText(comment.body));
    lines.push('');
  }

  if (omittedCount > 0) {
    lines.push(`... ${omittedCount} older top-level comments omitted.`);
  }

  return lines.join('\n').trim();
}

function formatCompactGitHubReviewComments(
  comments: Array<{ author: string; body: string; path?: string }>,
): string | undefined {
  if (comments.length === 0) {
    return undefined;
  }

  const recentComments = comments.slice(-10);
  const omittedCount = comments.length - recentComments.length;
  const lines = ['## Review Comments', ''];

  for (const comment of recentComments) {
    const pathSuffix = comment.path ? ` on \`${comment.path}\`` : '';
    lines.push(`Review comment from @${comment.author}${pathSuffix}:`);
    lines.push(formatQuotedText(comment.body));
    lines.push('');
  }

  if (omittedCount > 0) {
    lines.push(`... ${omittedCount} older review comments omitted.`);
  }

  return lines.join('\n').trim();
}

function buildCompactPullRequestDetails({
  repository,
  prNumber,
  prTitle,
  prBody,
  headRefName,
  prAuthorLogin,
}: {
  repository: string;
  prNumber: number;
  prTitle: string;
  prBody?: string;
  headRefName?: string;
  prAuthorLogin?: string;
}): string {
  const lines = [
    `Repository: ${repository}`,
    `Pull request: #${prNumber} - ${prTitle}`,
  ];

  if (headRefName) {
    lines.push(`Head branch: ${headRefName}`);
  }

  if (prAuthorLogin) {
    lines.push(`PR author: @${prAuthorLogin}`);
  }

  const trimmedBody = prBody?.trim();
  if (trimmedBody) {
    lines.push('', 'Body:', trimmedBody);
  }

  return lines.join('\n');
}

function buildCompactTriggeringComment({
  commenter,
  commentBody,
}: {
  commenter: string;
  commentBody: string;
}): string {
  return `${commenter} mentioned Roomote in the following GitHub pull request discussion:\n${formatQuotedText(commentBody)}`;
}

function buildReviewCommentTriggeringComment({
  commenter,
  commentBody,
}: {
  commenter: string;
  commentBody: string;
}): string {
  return `${commenter} mentioned Roomote in the following review comment:\n${formatQuotedText(commentBody)}`;
}

function buildReviewReplyTriggeringComment({
  commenter,
  commentBody,
  parentComment,
}: {
  commenter: string;
  commentBody: string;
  parentComment: ReviewCommentSnapshot;
}): string {
  const lines = [
    `${commenter} mentioned Roomote in a reply to review comment #${parentComment.id}:`,
    formatQuotedText(commentBody),
    '',
    `${parentComment.userLogin} wrote the following review comment that this reply is in response to:`,
    formatQuotedText(parentComment.body),
  ];

  if (parentComment.path && parentComment.diffHunk) {
    lines.push(
      '',
      '```diff',
      parentComment.path,
      parentComment.diffHunk,
      '```',
    );
  }

  return lines.join('\n');
}

async function buildTriggeringCommentContext({
  eventPayload,
  installationId,
  repositoryFullName,
  commenter,
  commentBody,
}: {
  eventPayload:
    | WebhookPullRequestCommentCreated
    | WebhookIssueCommentCreated
    | WebhookPullRequestReviewSubmitted;
  installationId: number;
  repositoryFullName: string;
  commenter: string;
  commentBody: string;
}): Promise<string> {
  if ('comment' in eventPayload && 'pull_request' in eventPayload) {
    const reviewComment = eventPayload.comment;

    if (reviewComment.in_reply_to_id) {
      const parentComment = await fetchReviewCommentSnapshot({
        installationId,
        repositoryFullName,
        commentId: reviewComment.in_reply_to_id,
      });

      if (parentComment) {
        return buildReviewReplyTriggeringComment({
          commenter,
          commentBody,
          parentComment,
        });
      }
    }

    return buildReviewCommentTriggeringComment({ commenter, commentBody });
  }

  return buildCompactTriggeringComment({ commenter, commentBody });
}

function buildActiveTaskFollowUpMessage({
  repository,
  prNumber,
  prTitle,
  prBody,
  headRefName,
  prAuthorLogin,
  commentId,
  commentBody,
  triggeringComment,
  reasoning,
  issueComments,
  reviewComments,
}: {
  repository: string;
  prNumber: number;
  prTitle: string;
  prBody?: string;
  headRefName?: string;
  prAuthorLogin?: string;
  commentId?: number;
  commentBody: string;
  triggeringComment: string;
  reasoning: string;
  issueComments: Array<{ author: string; body: string }>;
  reviewComments: Array<{ author: string; body: string; path?: string }>;
}): string {
  return buildGitHubExistingTaskFollowUpMessage({
    routingReason: reasoning,
    commentBody,
    taskContext: {
      repository,
      pull_request_number: prNumber,
      pull_request_details: buildCompactPullRequestDetails({
        repository,
        prNumber,
        prTitle,
        prBody,
        headRefName,
        prAuthorLogin,
      }),
      ...(commentId ? { triggering_comment_id: commentId } : {}),
      triggering_comment: triggeringComment,
      existing_review_comments:
        formatCompactGitHubReviewComments(reviewComments),
      issue_comments: formatCompactGitHubIssueComments(issueComments),
    },
  });
}

function buildRouterFailedComment(): string {
  return 'I saw the mention, but I could not route it into follow-up work right now. Please try again in a moment.';
}

function buildInternalErrorComment(): string {
  return 'I saw the mention, but I could not process it right now because the GitHub follow-up context was incomplete. Please try again in a moment.';
}

type PullRequestRoutingDetails = {
  branchName: string;
  prUrl: string;
  headSha: string;
};

type GitHubRoutingHistoryContext = {
  issueComments: Array<{ author: string; body: string }>;
  reviewComments: Array<{ author: string; body: string; path?: string }>;
};

const EXISTING_TASK_WAIT_TIMEOUT_MS = 15_000;
const EXISTING_TASK_WAIT_POLL_MS = 500;
const GITHUB_ROUTING_HISTORY_PAGE_SIZE = 100;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getSelectedRepositories(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const repositories = value.filter(
    (repository): repository is string => typeof repository === 'string',
  );

  return repositories.length > 0 ? repositories : undefined;
}

function getSlackOriginMessageTs(
  value: Record<string, unknown>,
): string | undefined {
  return asString(value.slackOriginMessageTs) ?? asString(value.ts);
}

function buildSnapshotResumeIntegrationMetadata(sourceJob: {
  slackThreadTs?: string | null;
  linearSessionId?: string | null;
  linearIssueId?: string | null;
  linearOrganizationId?: string | null;
}): Record<string, string> {
  const metadata: Record<string, string> = {};

  if (sourceJob.slackThreadTs) {
    metadata.slackThreadTs = sourceJob.slackThreadTs;
  }

  if (sourceJob.linearSessionId) {
    metadata.linearSessionId = sourceJob.linearSessionId;

    if (sourceJob.linearIssueId) {
      metadata.linearIssueId = sourceJob.linearIssueId;
    }

    if (sourceJob.linearOrganizationId) {
      metadata.linearOrganizationId = sourceJob.linearOrganizationId;
    }
  }

  return metadata;
}

async function listGitHubRoutingHistoryPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;

  while (true) {
    const pageItems = await fetchPage(page);

    if (pageItems.length === 0) {
      break;
    }

    items.push(...pageItems);

    if (pageItems.length < GITHUB_ROUTING_HISTORY_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return items;
}

async function getGitHubRoutingHistoryContext({
  installationId,
  repositoryFullName,
  prNumber,
}: {
  installationId: number;
  repositoryFullName: string;
  prNumber: number;
}): Promise<GitHubRoutingHistoryContext> {
  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return { issueComments: [], reviewComments: [] };
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    const issueCommentsRequest = octokit.rest.issues.listComments
      ? listGitHubRoutingHistoryPages((page) =>
          octokit.rest.issues
            .listComments({
              owner,
              repo,
              issue_number: prNumber,
              per_page: GITHUB_ROUTING_HISTORY_PAGE_SIZE,
              page,
            })
            .then((response) => response.data),
        )
      : Promise.resolve([]);
    const reviewCommentsRequest = octokit.rest.pulls.listReviewComments
      ? listGitHubRoutingHistoryPages((page) =>
          octokit.rest.pulls
            .listReviewComments({
              owner,
              repo,
              pull_number: prNumber,
              per_page: GITHUB_ROUTING_HISTORY_PAGE_SIZE,
              page,
            })
            .then((response) => response.data),
        )
      : Promise.resolve([]);
    const [issueCommentsResult, reviewCommentsResult] =
      await Promise.allSettled([issueCommentsRequest, reviewCommentsRequest]);

    return {
      issueComments:
        issueCommentsResult.status === 'fulfilled'
          ? issueCommentsResult.value
              .map((comment) => ({
                author: comment.user?.login?.trim() || 'unknown',
                body: comment.body?.trim() || '',
              }))
              .filter((comment) => comment.body.length > 0)
          : [],
      reviewComments:
        reviewCommentsResult.status === 'fulfilled'
          ? reviewCommentsResult.value
              .map((comment) => ({
                author: comment.user?.login?.trim() || 'unknown',
                body: comment.body?.trim() || '',
                path: comment.path?.trim() || undefined,
              }))
              .filter((comment) => comment.body.length > 0)
          : [],
    };
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to fetch GitHub routing history for ${repositoryFullName}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return { issueComments: [], reviewComments: [] };
  }
}

async function waitForTaskToAcceptMessages({
  taskId,
  timeoutMs = EXISTING_TASK_WAIT_TIMEOUT_MS,
}: {
  taskId: string;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const latestJob = await findLatestCloudJob(taskId, {
      id: true,
      status: true,
      taskPhase: true,
      sandboxServerUrl: true,
    });

    if (!latestJob || isExitedCloudTaskStatus(latestJob.status)) {
      return null;
    }

    if (latestJob.sandboxServerUrl) {
      return latestJob;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, EXISTING_TASK_WAIT_POLL_MS),
    );
  }

  return null;
}

function getDeferredResumePromptAccepted(result: unknown): boolean | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const accepted = (result as Record<string, unknown>)
    .deferredResumePromptAccepted;

  return typeof accepted === 'boolean' ? accepted : null;
}

async function waitForResumeJobToAcceptDeferredPrompt({
  taskId,
  resumeJobId,
  timeoutMs = EXISTING_TASK_WAIT_TIMEOUT_MS,
}: {
  taskId: string;
  resumeJobId: number;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + timeoutMs;
  let latestJob:
    | {
        id: number;
        status: CloudTaskStatus;
        result: unknown;
      }
    | null
    | undefined = null;

  while (Date.now() < deadline) {
    latestJob = await findLatestCloudJob(taskId, {
      id: true,
      status: true,
      result: true,
    });

    if (!latestJob) {
      return false;
    }

    if (latestJob.id === resumeJobId) {
      const accepted = getDeferredResumePromptAccepted(latestJob.result);

      if (accepted === true) {
        return true;
      }

      if (accepted === false || isExitedCloudTaskStatus(latestJob.status)) {
        return false;
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, EXISTING_TASK_WAIT_POLL_MS),
    );
  }

  if (!latestJob || latestJob.id !== resumeJobId) {
    return false;
  }

  const accepted = getDeferredResumePromptAccepted(latestJob.result);

  if (accepted === true) {
    return true;
  }

  if (accepted === false || isExitedCloudTaskStatus(latestJob.status)) {
    return false;
  }

  return null;
}

async function resolveReusableTaskSenderUserId({
  taskId,
  preferredUserId,
}: {
  taskId: string;
  preferredUserId?: string | null;
}): Promise<string | null> {
  if (preferredUserId) {
    return preferredUserId;
  }

  const latestJob = await findLatestCloudJob(taskId, {
    id: true,
    userId: true,
    actingUserId: true,
  });

  if (!latestJob) {
    return null;
  }

  return (
    latestJob.actingUserId ??
    (await resolveUserIdForCloudJob({
      id: latestJob.id,
      userId: latestJob.userId,
    }))
  );
}

/**
 * Resolve a display name for the Slack reply quote attribution so the quote
 * names the actual commenter rather than the reusable task owner (which
 * `resolveReusableTaskSenderUserId` falls back to when the commenter has no
 * linked account). Uses the linked Roomote user's name when available, the
 * GitHub login as a fallback, and returns undefined when neither is known.
 */
async function resolveCommenterDisplayName({
  commenterUserId,
  commenterGithubLogin,
}: {
  commenterUserId: string | null | undefined;
  commenterGithubLogin: string | null | undefined;
}): Promise<string | undefined> {
  if (commenterUserId) {
    try {
      return await getTrackedUserDisplayName(commenterUserId);
    } catch {
      // Fall through to the GitHub login fallback below.
    }
  }

  const login = commenterGithubLogin?.trim();
  return login ? login : undefined;
}

async function deliverFollowUpToExistingTask({
  taskId,
  userId,
  message,
  status,
  taskPhase,
  commenterDisplayName,
}: {
  taskId: string;
  userId?: string | null;
  message: string;
  status: CloudTaskStatus;
  taskPhase: string | null;
  commenterDisplayName?: string;
}) {
  const senderUserId = await resolveReusableTaskSenderUserId({
    taskId,
    preferredUserId: userId,
  });

  if (!senderUserId) {
    return {
      success: false as const,
      error: 'Reusable PR owner has no delivery user',
      status: 409 as const,
    };
  }

  const deliver = ({
    status,
    taskPhase,
  }: {
    status: CloudTaskStatus;
    taskPhase: string | null;
  }) =>
    isActivelyRunningCloudTask(status, taskPhase)
      ? steerMessageToTask({
          taskId,
          userId: senderUserId,
          message,
          senderMode: 'github_pr_follow_up',
          ...(commenterDisplayName
            ? { workerQuoteUserName: commenterDisplayName }
            : {}),
        })
      : sendMessageToTask({
          taskId,
          userId: senderUserId,
          message,
          senderMode: 'github_pr_follow_up',
          ...(commenterDisplayName
            ? { workerQuoteUserName: commenterDisplayName }
            : {}),
        });

  const initialAttempt = await deliver({ status, taskPhase });

  if (
    initialAttempt.success ||
    initialAttempt.status !== 409 ||
    !initialAttempt.error.includes('no active sandbox')
  ) {
    return initialAttempt;
  }

  const readyJob = await waitForTaskToAcceptMessages({ taskId });

  if (!readyJob) {
    return initialAttempt;
  }

  return deliver({
    status: readyJob.status,
    taskPhase: readyJob.taskPhase,
  });
}

async function resumeExistingTaskAndDeliverFollowUp({
  taskId,
  userId,
  sourceJobId,
  message,
  resumePromptFallbackTask,
}: {
  taskId: string;
  userId?: string | null;
  sourceJobId: number;
  message: string;
  resumePromptFallbackTask: SnapshotResumePromptFallbackTask;
}) {
  const sourceJob = await findLatestCloudJob(taskId, {
    id: true,
    type: true,
    status: true,
    taskPhase: true,
    snapshotId: true,
    snapshotCreatedAt: true,
    payload: true,
    port: true,
    userId: true,
    actingUserId: true,
    slackThreadTs: true,
    linearSessionId: true,
    linearIssueId: true,
    linearOrganizationId: true,
  });

  if (!sourceJob) {
    return { success: false as const, error: 'Task not found', status: 404 };
  }

  if (sourceJob.id !== sourceJobId) {
    return {
      success: false as const,
      error: 'Reusable PR owner changed before follow-up delivery',
      status: 409,
    };
  }

  if (!sourceJob.snapshotId) {
    return {
      success: false as const,
      error: 'Reusable PR owner has no snapshot to resume',
      status: 409,
    };
  }

  if (!isSnapshotResumable(sourceJob.snapshotCreatedAt)) {
    return {
      success: false as const,
      error: EXPIRED_SNAPSHOT_RESUME_ERROR,
      status: 409,
    };
  }

  if (!isExitedCloudTaskStatus(sourceJob.status)) {
    return deliverFollowUpToExistingTask({
      taskId,
      userId,
      message,
      status: sourceJob.status,
      taskPhase: sourceJob.taskPhase,
    });
  }

  if (!sourceJob.snapshotId) {
    return {
      success: false as const,
      error: 'Reusable PR owner has no snapshot to resume',
      status: 409,
    };
  }

  const senderUserId =
    userId ??
    sourceJob.actingUserId ??
    (await resolveUserIdForCloudJob({
      id: sourceJob.id,
      userId: sourceJob.userId,
    }));

  if (!senderUserId) {
    return {
      success: false as const,
      error: 'Reusable PR owner has no delivery user',
      status: 409,
    };
  }

  const sourcePayload = (sourceJob.payload ?? {}) as Record<string, unknown>;
  const selectedRepositories = getSelectedRepositories(
    sourcePayload.selectedRepositories,
  );
  const slackOriginMessageTs = getSlackOriginMessageTs(sourcePayload);

  const resumePayload = {
    repo: asString(sourcePayload.repo) ?? '',
    environmentId: asString(sourcePayload.environmentId),
    port: sourceJob.port ?? undefined,
    sourceSnapshotId: sourceJob.snapshotId,
    sourceCloudJobId: sourceJob.id,
    ...(selectedRepositories ? { selectedRepositories } : {}),
    ...(slackOriginMessageTs ? { slackOriginMessageTs } : {}),
    // Carry the follow-up on the resume job itself so the resumed worker can
    // send it after the harness session is actually ready.
    resumePrompt: message,
    resumePromptSource: 'github',
    resumePromptUserId: senderUserId,
    resumePromptFallbackTask,
  } satisfies CloudTaskPayload<CloudTaskType.SnapshotResume>;
  populateSnapshotResumeSlackMetadata(resumePayload, {
    sourcePayload,
    threadTs: sourceJob.slackThreadTs,
  });
  restoreSnapshotResumeVisiblePromptFields(resumePayload, sourcePayload);

  const resumeLaunch = await enqueueCloudTask(
    {
      userId: sourceJob.userId ?? senderUserId,
      type: CloudTaskType.SnapshotResume,
      sourceSnapshotId: sourceJob.snapshotId,
      sourceCloudJobId: sourceJob.id,
      ...buildSnapshotResumeIntegrationMetadata(sourceJob),
      payload: resumePayload,
    },
    {},
  );

  const accepted = await waitForResumeJobToAcceptDeferredPrompt({
    taskId,
    resumeJobId: resumeLaunch.id,
  });

  if (accepted === false) {
    const fallbackCloudJob = await ensureSnapshotResumeGitHubFollowUpFallback({
      resumeJobId: resumeLaunch.id,
    });

    return {
      success: false as const,
      error: 'Resumed PR owner did not accept the deferred follow-up prompt',
      status: 409,
      fallbackCloudJob,
    };
  }

  return {
    success: true as const,
    result: {
      accepted: true,
      queuedToResumeJobId: resumeLaunch.id,
      ...(accepted === null ? { pendingResumePromptAcceptance: true } : {}),
    },
  };
}

async function getPullRequestRoutingDetails({
  eventPayload,
  installationId,
  repositoryFullName,
  prNumber,
}: {
  eventPayload:
    | WebhookPullRequestCommentCreated
    | WebhookIssueCommentCreated
    | WebhookPullRequestReviewSubmitted;
  installationId: number;
  repositoryFullName: string;
  prNumber: number;
}): Promise<PullRequestRoutingDetails> {
  if ('pull_request' in eventPayload) {
    const branchName = eventPayload.pull_request.head?.ref ?? '';
    const prUrl = eventPayload.pull_request.html_url ?? '';
    const headSha = eventPayload.pull_request.head?.sha ?? '';

    if (branchName && prUrl && headSha) {
      return { branchName, prUrl, headSha };
    }
  }

  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return { branchName: '', prUrl: '', headSha: '' };
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    const pullRequest = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    return {
      branchName: pullRequest.data.head.ref ?? '',
      prUrl: pullRequest.data.html_url ?? '',
      headSha: pullRequest.data.head.sha ?? '',
    };
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to fetch PR details for ${repositoryFullName}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { branchName: '', prUrl: '', headSha: '' };
  }
}

export async function handlePrComment(
  eventPayload:
    | WebhookPullRequestCommentCreated
    | WebhookIssueCommentCreated
    | WebhookPullRequestReviewSubmitted,
): Promise<WebhookResponse> {
  const { installation, repository, sender, ...rest } = eventPayload;
  const isSubmittedReview = 'review' in rest;
  const mention = isSubmittedReview ? rest.review : rest.comment;

  if (
    !isMention({
      body: mention.body ?? '',
      user: mention.user ? { login: mention.user.login } : null,
    })
  ) {
    return { status: 'ok', message: 'no_mention' };
  }

  const githubInstallationId = installation?.id;
  const mentionResponseTarget = getMentionResponseTarget(eventPayload);

  if (!githubInstallationId) {
    return { status: 'error', message: 'no_installation' };
  }

  const pr = 'issue' in rest ? rest.issue : rest.pull_request;
  const prAuthorLogin = pr.user?.login?.toLowerCase();

  if (!prAuthorLogin) {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body: buildInternalErrorComment(),
    });

    return { status: 'ok', message: 'no_pr_author' };
  }

  const reviewerGate = await getGitHubAutomationTargets({
    type: CloudAgentType.PrReviewer,
    installation,
    repository,
    sender,
    author: prAuthorLogin,
    ignoreRoomoteAuthorRequirement: true,
    requireLinkedSenderAccount: true,
  });

  if (reviewerGate.status === 'error') {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body:
        reviewerGate.code === 'account_link_required'
          ? buildSourceControlAccountLinkRequiredMessage('github')
          : buildReviewerGateMissComment(),
    });

    return {
      status: 'ok',
      message:
        reviewerGate.code === 'account_link_required'
          ? 'account_link_required'
          : 'reviewer_gate_miss',
    };
  }

  const reviewers = reviewerGate.targets;
  const reviewer = reviewers[0];

  if (!reviewer) {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body: buildInternalErrorComment(),
    });

    return { status: 'error', message: 'no_reviewer_context' };
  }

  const routingDetails = await getPullRequestRoutingDetails({
    eventPayload,
    installationId: githubInstallationId,
    repositoryFullName: repository.full_name,
    prNumber: pr.number,
  });

  const routingContext = buildGitHubRoutingContext({
    taskDescription: mention.body ?? '',
    repository: repository.full_name,
    headRefName: routingDetails.branchName || undefined,
    prAuthorLogin: pr.user?.login ?? undefined,
    issueOrPrTitle: pr.title,
    issueOrPrBody: pr.body ?? undefined,
    commentBody: mention.body ?? '',
    availableAgents: [],
  });

  const routingDecision = await routeGitHubTask(routingContext);

  if (routingDecision.status === 'fallback') {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body: buildRouterFailedComment(),
    });

    return {
      status: 'error',
      message: `router_failed:${routingDecision.reason}`,
    };
  }

  const routingReason = routingDecision.result.reasoning;

  if (routingDecision.result.followUpMode === 'review') {
    const { branchName, prUrl, headSha } = routingDetails;

    if (!branchName || !prUrl || !headSha) {
      await postMentionResponseComment({
        installationId: githubInstallationId,
        target: mentionResponseTarget,
        body: buildReviewTaskStartFailedComment(),
      });

      return {
        status: 'error',
        message: 'review_start_context_incomplete',
      };
    }

    const activeReviewTask = await findActiveGitHubPrReviewTask({
      repoFullName: repository.full_name,
      prNumber: pr.number,
      headSha,
    });

    if (activeReviewTask?.taskId) {
      const taskCommentBody = formatGitHubPrMentionReply(
        { kind: 'active_review' },
        tryBuildGitHubPrMentionReplyLink({
          kind: 'task',
          taskId: activeReviewTask.taskId,
          utm: {
            source: 'github-comment',
            campaign: 'github.pr.mention.review.active',
          },
          warning: `[handlePrComment] failed to build active PR review task link for ${repository.full_name}#${pr.number}`,
        }),
      );

      await postMentionResponseComment({
        installationId: githubInstallationId,
        target: mentionResponseTarget,
        body: taskCommentBody,
      });

      return { status: 'ok', message: 'active_pr_review_linked' };
    }

    const reviewPayloadBase = {
      repo: repository.full_name,
      prNumber: pr.number,
      prTitle: pr.title,
      prUrl,
      headSha,
      branchName,
    };

    const reviewLaunches: Array<Awaited<ReturnType<typeof enqueueCloudTask>>> =
      [];
    const failedReviewerIds: string[] = [];

    for (const reviewer of reviewers) {
      const relayPayload = await getReviewTaskRelayPayload({
        repository: repository.full_name,
        prNumber: pr.number,
        branchName,
        prBody: pr.body ?? null,
        reviewerSettings: reviewer.settings,
      });
      const reviewPayload = {
        ...reviewPayloadBase,
        ...relayPayload,
      } satisfies CloudTaskPayload<CloudTaskType.GithubPrReview>;

      try {
        const reviewLaunch = await enqueueCloudTask({
          type: CloudTaskType.GithubPrReview,
          payload: reviewPayload,
          ...reviewer.properties,
        });
        reviewLaunches.push(reviewLaunch);
      } catch (error) {
        failedReviewerIds.push(reviewer.id);
        console.warn(
          `[handlePrComment] failed to start PR review task for reviewer ${reviewer.id} on ${repository.full_name}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (reviewLaunches.length === 0) {
      await postMentionResponseComment({
        installationId: githubInstallationId,
        body: buildReviewTaskStartFailedComment(),
        target: mentionResponseTarget,
      });

      return {
        status: 'error',
        message: failedReviewerIds.length
          ? `review_start_failed:failed_reviewers=${failedReviewerIds.join(',')}`
          : 'review_start_failed:No PR review tasks were enqueued',
      };
    }

    try {
      const directReviewLaunches = reviewLaunches;
      const firstDirectReviewLaunch = directReviewLaunches[0];
      const taskCommentBody = formatGitHubPrMentionReply(
        {
          kind: 'review_started',
          count: reviewLaunches.length,
          partial: failedReviewerIds.length > 0,
        },
        firstDirectReviewLaunch
          ? tryBuildGitHubPrMentionReplyLink({
              kind: 'task',
              taskId: firstDirectReviewLaunch.taskId,
              utm: {
                source: 'github-comment',
                campaign: 'github.pr.mention.review',
              },
              warning: `[handlePrComment] failed to build PR review task link for ${repository.full_name}#${pr.number}`,
            })
          : null,
      );

      await postMentionResponseComment({
        installationId: githubInstallationId,
        target: mentionResponseTarget,
        body: taskCommentBody,
      });

      const metadata = {
        ...(directReviewLaunches.length > 0
          ? {
              ids: directReviewLaunches.map((launch) => launch.id),
            }
          : {}),
      };

      return {
        status: 'ok',
        ...(failedReviewerIds.length > 0
          ? {
              message: `review_start_partial:failed_reviewers=${failedReviewerIds.join(',')}`,
            }
          : {}),
        metadata,
      };
    } catch (error) {
      console.warn(
        `[handlePrComment] failed to start PR review task for ${repository.full_name}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
      );

      await postMentionResponseComment({
        installationId: githubInstallationId,
        body: buildReviewTaskStartFailedComment(),
        target: mentionResponseTarget,
      });

      return {
        status: 'error',
        message: `review_start_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const branchName = routingDetails.branchName;

  const activePrOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName: repository.full_name,
    prNumber: pr.number,
    branchName,
  });

  if (activePrOwner?.taskId) {
    const routingHistory = await getGitHubRoutingHistoryContext({
      installationId: githubInstallationId,
      repositoryFullName: repository.full_name,
      prNumber: pr.number,
    });
    const triggeringComment = await buildTriggeringCommentContext({
      eventPayload,
      installationId: githubInstallationId,
      repositoryFullName: repository.full_name,
      commenter: sender.login,
      commentBody: mention.body ?? '',
    });
    const followUpMessage = buildActiveTaskFollowUpMessage({
      repository: repository.full_name,
      prNumber: pr.number,
      prTitle: pr.title,
      prBody: pr.body ?? undefined,
      headRefName: branchName || undefined,
      prAuthorLogin: pr.user?.login ?? undefined,
      commentId: !isSubmittedReview ? rest.comment.id : undefined,
      commentBody: mention.body ?? '',
      triggeringComment,
      reasoning: routingReason,
      issueComments: routingHistory.issueComments,
      reviewComments: routingHistory.reviewComments,
    });
    const resumePromptFallbackTask = {
      type: CloudTaskType.GithubPrReviewFollowUp,
      userId: reviewer.properties.userId ?? undefined,
      githubLogin: reviewer.properties.githubLogin ?? undefined,
      githubUserId: reviewer.properties.githubUserId ?? undefined,
      payload: {
        repo: repository.full_name,
        prNumber: pr.number,
        prTitle: pr.title,
        ...(!isSubmittedReview ? { commentId: rest.comment.id } : {}),
        commentBody: mention.body ?? '',
        followUpSource: 'github_mention',
      },
    } satisfies SnapshotResumePromptFallbackTask;
    const commenterDisplayName = await resolveCommenterDisplayName({
      commenterUserId: reviewer.properties.userId,
      commenterGithubLogin: reviewer.properties.githubLogin,
    });
    const followUpResult =
      activePrOwner.delivery === 'resume'
        ? await resumeExistingTaskAndDeliverFollowUp({
            taskId: activePrOwner.taskId,
            userId: reviewer.properties.userId,
            sourceJobId: activePrOwner.jobId,
            message: followUpMessage,
            resumePromptFallbackTask,
          })
        : await deliverFollowUpToExistingTask({
            taskId: activePrOwner.taskId,
            userId: reviewer.properties.userId,
            message: followUpMessage,
            status: activePrOwner.status,
            taskPhase: activePrOwner.taskPhase,
            commenterDisplayName,
          });

    if (followUpResult.success) {
      const taskCommentBody = formatGitHubPrMentionReply(
        { kind: 'active_follow_up' },
        tryBuildGitHubPrMentionReplyLink({
          kind: 'task',
          taskId: activePrOwner.taskId,
          utm: {
            source: 'github-comment',
            campaign: 'github.pr.mention.active-owner',
          },
          warning: `[handlePrComment] failed to build active PR owner task link for ${repository.full_name}#${pr.number}`,
        }),
      );

      await postMentionResponseComment({
        installationId: githubInstallationId,
        target: mentionResponseTarget,
        body: taskCommentBody,
      });

      return { status: 'ok', message: 'active_pr_owner_routed' };
    }

    console.warn(
      `[handlePrComment] failed to deliver routed PR mention to reusable task ${activePrOwner.taskId}: ${followUpResult.error}`,
    );

    const fallbackCloudJob =
      'fallbackCloudJob' in followUpResult
        ? followUpResult.fallbackCloudJob
        : null;

    if (fallbackCloudJob) {
      const taskCommentBody = formatGitHubPrMentionReply(
        { kind: 'dedicated_follow_up' },
        fallbackCloudJob.taskId
          ? tryBuildGitHubPrMentionReplyLink({
              kind: 'task',
              taskId: fallbackCloudJob.taskId,
              utm: {
                source: 'github-comment',
                campaign: 'github.pr.mention',
              },
              warning: `[handlePrComment] failed to build fallback PR follow-up task link for ${repository.full_name}#${pr.number}`,
            })
          : null,
      );

      await postMentionResponseComment({
        installationId: githubInstallationId,
        target: mentionResponseTarget,
        body: taskCommentBody,
      });

      return { status: 'ok', metadata: { ids: [fallbackCloudJob.id] } };
    }
  }

  if (!branchName) {
    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body: buildFollowUpSafetyCheckFailedComment(),
    });

    return {
      status: 'error',
      message: 'active_pr_owner_branch_unknown',
    };
  }

  const payload = {
    repo: repository.full_name,
    prNumber: pr.number,
    prTitle: pr.title,
    ...(!isSubmittedReview ? { commentId: rest.comment.id } : {}),
    commentBody: mention.body ?? '',
    followUpSource: 'github_mention',
  } satisfies CloudTaskPayload<CloudTaskType.GithubPrReviewFollowUp>;

  try {
    const followUpLaunch = await enqueueCloudTask({
      type: CloudTaskType.GithubPrReviewFollowUp,
      payload,
      ...reviewer.properties,
    });

    const taskCommentBody = formatGitHubPrMentionReply(
      { kind: 'dedicated_follow_up' },
      tryBuildGitHubPrMentionReplyLink({
        kind: 'task',
        taskId: followUpLaunch.taskId,
        utm: {
          source: 'github-comment',
          campaign: 'github.pr.mention',
        },
        warning: `[handlePrComment] failed to build dedicated PR follow-up task link for ${repository.full_name}#${pr.number}`,
      }),
    );

    await postMentionResponseComment({
      installationId: githubInstallationId,
      target: mentionResponseTarget,
      body: taskCommentBody,
    });

    return {
      status: 'ok',
      metadata: { ids: [followUpLaunch.id] },
    };
  } catch (error) {
    console.warn(
      `[handlePrComment] failed to start dedicated PR follow-up task for ${repository.full_name}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postMentionResponseComment({
      installationId: githubInstallationId,
      body: buildDedicatedTaskStartFailedComment(),
      target: mentionResponseTarget,
    });

    return {
      status: 'error',
      message: `followup_start_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

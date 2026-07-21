import {
  buildMentionRequestBlock,
  buildUntrustedContentPolicy,
  enqueueTask,
  escapeTaskContextText,
  getTaskUrl,
} from '@roomote/cloud-agents/server';
import {
  findActiveGitHubPrReviewTask,
  findReusableGitHubPrFollowUpOwner,
} from '@roomote/db/server';
import {
  createGiteaIssueComment,
  createGiteaPullRequestComment,
  getGiteaDeploymentUser,
} from '@roomote/gitea';
import {
  type TaskPayload,
  TaskPayloadKind,
  PRODUCT_NAME,
  isActivelyRunningTask,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';
import {
  buildSourceControlAccountLinkRequiredMessage,
  buildSourceControlEnvironmentRequiredMessage,
} from '../source-control-account-linking';
import { orchestrateIssueMention } from '../shared/issue-mention-orchestration';
import {
  sendMessageToTask,
  steerMessageToTask,
} from '../tasks/sendMessageToTask';
import {
  getGiteaAutomationTargets,
  getGiteaUsername,
  isRoomoteGiteaUsername,
} from './getGiteaAutomationTargets';
import { toHostFromUrl } from '../utils';
import type { GiteaPullRequestCommentWebhook } from './types';

const GITEA_MENTION_HANDLE = '@roomote';

type GiteaPrMentionReplyKind =
  | 'active_follow_up'
  | 'active_review'
  | 'review_started';

type GiteaIssueMentionReplyKind = 'active_follow_up' | 'task_started';

type GiteaCommentPullRequest = NonNullable<
  GiteaPullRequestCommentWebhook['pull_request']
>;

type GiteaCommentIssue = NonNullable<GiteaPullRequestCommentWebhook['issue']>;

type HandleGiteaCommentOptions = {
  /**
   * When true (pull_request_comment events), always take the PR path even if
   * `is_pull` is missing from the payload.
   */
  forcePullRequestComment?: boolean;
};

function isGiteaMention(commentBody: string): boolean {
  return commentBody.toLowerCase().includes(GITEA_MENTION_HANDLE);
}

type GiteaWebhookAuthor =
  | GiteaPullRequestCommentWebhook['comment']['user']
  | GiteaPullRequestCommentWebhook['sender']
  | undefined;

function matchesDeploymentIdentity(
  author: GiteaWebhookAuthor,
  deploymentUser: Awaited<ReturnType<typeof getGiteaDeploymentUser>>,
): boolean {
  if (!deploymentUser || !author) {
    return false;
  }

  if (
    typeof author.id === 'number' &&
    typeof deploymentUser.id === 'number' &&
    author.id === deploymentUser.id
  ) {
    return true;
  }

  const username = getGiteaUsername(author);

  return (
    !!username && deploymentUser.login.toLowerCase() === username.toLowerCase()
  );
}

async function isDeploymentTokenAuthor(
  authors: GiteaWebhookAuthor[],
): Promise<boolean> {
  try {
    const deploymentUser = await getGiteaDeploymentUser();

    if (!deploymentUser) {
      return false;
    }

    return authors.some((author) =>
      matchesDeploymentIdentity(author, deploymentUser),
    );
  } catch (error) {
    console.warn(
      `[handleGiteaComment] failed to resolve Gitea deployment token identity: ${error instanceof Error ? error.message : String(error)}`,
    );

    return false;
  }
}

async function postPullRequestMentionResponseComment({
  repositoryFullName,
  pullRequestNumber,
  body,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  body: string;
}): Promise<void> {
  try {
    await createGiteaPullRequestComment({
      repositoryFullName,
      pullRequestNumber,
      body,
    });
  } catch (error) {
    console.warn(
      `[handleGiteaComment] failed to post mention response comment on ${repositoryFullName}#${pullRequestNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function postIssueMentionResponseComment({
  repositoryFullName,
  issueNumber,
  body,
}: {
  repositoryFullName: string;
  issueNumber: number;
  body: string;
}): Promise<void> {
  try {
    await createGiteaIssueComment({
      repositoryFullName,
      issueNumber,
      body,
    });
  } catch (error) {
    console.warn(
      `[handleGiteaComment] failed to post mention response comment on ${repositoryFullName} issue #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function tryBuildTaskLink({
  taskId,
  campaign,
}: {
  taskId: string;
  campaign: string;
}): string | null {
  try {
    return getTaskUrl({
      taskId,
      utm: { source: 'gitea-comment', campaign },
    });
  } catch (error) {
    console.warn(
      `[handleGiteaComment] failed to build task link for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return null;
  }
}

function formatGiteaPrMentionReply(
  kind: GiteaPrMentionReplyKind,
  link: string | null,
): string {
  const replyCopy = (() => {
    switch (kind) {
      case 'active_follow_up':
        return {
          intro:
            "I'm on it. I routed this request into the existing task for this pull request so follow-up work stays on one Roomote thread, and I'll keep updates here.",
          fallback:
            'I could not generate the task link for this comment, but the follow-up was delivered.',
        };
      case 'active_review':
        return {
          intro:
            'I found a pull request review already running for this request, and I will keep updates here.',
          fallback:
            'I could not generate the task link for this comment, but the review is already in progress.',
        };
      case 'review_started':
        return {
          intro:
            'I started a pull request review task for this request, and I will keep updates here.',
          fallback:
            'I could not generate the task link for this comment, but the review task is already running.',
        };
    }
  })();

  if (!link) {
    return `${replyCopy.intro} ${replyCopy.fallback}`;
  }

  return `${replyCopy.intro} [See task](${link})`;
}

function formatGiteaIssueMentionReply(
  kind: GiteaIssueMentionReplyKind,
  link: string | null,
): string {
  const replyCopy = (() => {
    switch (kind) {
      case 'active_follow_up':
        return {
          intro:
            "I'm on it. I routed this request into the existing task for this issue so follow-up work stays on one Roomote thread, and I'll keep updates here.",
          fallback:
            'I could not generate the task link for this comment, but the follow-up was delivered.',
        };
      case 'task_started':
        return {
          intro:
            "I'm on it. I started a task for this issue, and I'll keep updates here.",
          fallback:
            'I could not generate the task link for this comment, but the task is already running.',
        };
    }
  })();

  if (!link) {
    return `${replyCopy.intro} ${replyCopy.fallback}`;
  }

  return `${replyCopy.intro} [See task](${link})`;
}

function buildReviewerGateMissComment(): string {
  return `I saw the mention, but I could not start work on this pull request with the current ${PRODUCT_NAME} Gitea setup.`;
}

function buildIssueGateMissComment(): string {
  return `I saw the mention, but I could not start work on this issue with the current ${PRODUCT_NAME} Gitea setup.`;
}

function buildTaskStartFailedComment(
  surface: 'pull request' | 'issue',
): string {
  return `I saw the mention, but I could not start a task for this ${surface} right now. Please try again in a moment.`;
}

function buildExistingTaskFollowUpMessage({
  repoFullName,
  pullRequest,
  commenter,
  commentBody,
}: {
  repoFullName: string;
  pullRequest: GiteaCommentPullRequest;
  commenter: string;
  commentBody: string;
}): string {
  const lines = [
    `${commenter} mentioned Roomote in a comment on Gitea pull request #${pullRequest.number} (${escapeTaskContextText(pullRequest.title)}) in ${repoFullName}.`,
    '',
    'Please act on this comment as a follow-up to your existing work on this pull request.',
  ];

  if (pullRequest.head?.ref) {
    lines.push(
      `The pull request source branch is \`${pullRequest.head.ref}\`.`,
    );
  }

  lines.push(
    '',
    'Mention comment (the request to act on):',
    buildMentionRequestBlock(commentBody),
    '',
    buildUntrustedContentPolicy(),
  );

  return lines.join('\n');
}

/**
 * Pull-request context for comments. Only synthesize a PR from `issue` when
 * this truly is a PR comment (`is_pull === true` or forcePullRequestComment).
 * Plain issues must not become fake PRs.
 */
function resolveGiteaCommentPullRequest(
  payload: GiteaPullRequestCommentWebhook,
): GiteaCommentPullRequest | null {
  if (payload.pull_request) {
    return payload.pull_request;
  }

  if (payload.issue?.number) {
    return {
      number: payload.issue.number,
      title: payload.issue.title ?? `Pull request #${payload.issue.number}`,
    };
  }

  return null;
}

function resolveGiteaCommentIssue(
  payload: GiteaPullRequestCommentWebhook,
): GiteaCommentIssue | null {
  if (payload.issue?.number) {
    return payload.issue;
  }

  return null;
}

async function handleGiteaIssueComment({
  payload,
  commenter,
  repoFullName,
  issue,
}: {
  payload: GiteaPullRequestCommentWebhook;
  commenter: string;
  repoFullName: string;
  issue: GiteaCommentIssue;
}): Promise<WebhookResponse> {
  const mentionResponseTarget = {
    repositoryFullName: repoFullName,
    issueNumber: issue.number,
  };

  // Skip pr_review automation gates. Issue mentions only need a linked sender
  // and a mapped environment, matching GitHub/GitLab issue comment handling.
  const targetsResult = await getGiteaAutomationTargets({
    workflow: 'pr_conflict_resolve',
    payload: {
      repository: payload.repository,
      sender: payload.sender,
      commentAuthor: payload.comment.user,
    },
    webhookHost: toHostFromUrl(
      issue.html_url ?? issue.url ?? payload.repository.html_url ?? '',
    ),
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  if (!target || !target.userId) {
    await postIssueMentionResponseComment({
      ...mentionResponseTarget,
      body:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? buildSourceControlAccountLinkRequiredMessage('gitea')
          : buildIssueGateMissComment(),
    });

    return {
      status: 'ok',
      message:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? 'account_link_required'
          : 'issue_gate_miss',
    };
  }

  const issueUrl =
    issue.html_url ??
    issue.url ??
    (payload.repository.html_url
      ? `${payload.repository.html_url}/issues/${issue.number}`
      : '');
  const issueTitle = issue.title ?? `Issue #${issue.number}`;
  const issueBody = issue.body ?? null;

  return orchestrateIssueMention({
    provider: 'gitea',
    logPrefix: '[handleGiteaComment]',
    repositoryId: target.repo.id,
    repositoryFullName: repoFullName,
    issueNumber: issue.number,
    issueTitle,
    issueBody,
    issueUrl,
    commentBody: payload.comment.body,
    commenterLogin: commenter,
    commenterUserId: target.userId,
    sourceControlHost: target.repo.host ?? null,
    includeSourceControlOnPayload: true,
    providerDisplayName: 'Gitea',
    issueBodySource: 'gitea_issue_body',
    issueBodyContextLabel: 'Issue body (context only):',
    postComment: (body) =>
      postIssueMentionResponseComment({ ...mentionResponseTarget, body }),
    formatFollowUpReply: (taskLink) =>
      formatGiteaIssueMentionReply('active_follow_up', taskLink),
    formatStartedReply: (taskLink) =>
      formatGiteaIssueMentionReply('task_started', taskLink),
    formatStartFailed: () => buildTaskStartFailedComment('issue'),
    tryBuildTaskLink,
  });
}

async function handleGiteaPullRequestComment({
  payload,
  commenter,
  repoFullName,
  pullRequest,
}: {
  payload: GiteaPullRequestCommentWebhook;
  commenter: string;
  repoFullName: string;
  pullRequest: GiteaCommentPullRequest;
}): Promise<WebhookResponse> {
  const mentionResponseTarget = {
    repositoryFullName: repoFullName,
    pullRequestNumber: pullRequest.number,
  };

  const targetsResult = await getGiteaAutomationTargets({
    workflow: 'pr_review',
    payload: {
      repository: payload.repository,
      sender: payload.sender,
      commentAuthor: payload.comment.user,
    },
    // The PR (or repository) web URL carries the instance host, matching
    // repositories.host.
    webhookHost: toHostFromUrl(
      pullRequest.html_url ??
        pullRequest.url ??
        payload.repository.html_url ??
        '',
    ),
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  // requireLinkedSenderAccount guarantees a linked commenter here.
  if (!target || !target.userId) {
    await postPullRequestMentionResponseComment({
      ...mentionResponseTarget,
      body:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? buildSourceControlAccountLinkRequiredMessage('gitea')
          : targetsResult.status === 'error' &&
              targetsResult.message.includes('no environment mapping')
            ? buildSourceControlEnvironmentRequiredMessage('gitea')
            : buildReviewerGateMissComment(),
    });

    return {
      status: 'ok',
      message:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? 'account_link_required'
          : 'reviewer_gate_miss',
    };
  }

  const branchName = pullRequest.head?.ref ?? '';

  const activeOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName,
    prNumber: pullRequest.number,
    branchName,
    sourceControlProvider: 'gitea',
  });

  if (activeOwner?.taskId) {
    const followUpMessage = buildExistingTaskFollowUpMessage({
      repoFullName,
      pullRequest,
      commenter,
      commentBody: payload.comment.body,
    });
    const delivery = isActivelyRunningTask(
      activeOwner.status,
      activeOwner.taskPhase,
    )
      ? await steerMessageToTask({
          taskId: activeOwner.taskId,
          userId: target.userId,
          message: followUpMessage,
          senderMode: 'github_pr_follow_up',
        })
      : await sendMessageToTask({
          taskId: activeOwner.taskId,
          userId: target.userId,
          message: followUpMessage,
          senderMode: 'github_pr_follow_up',
        });

    if (delivery.success) {
      await postPullRequestMentionResponseComment({
        ...mentionResponseTarget,
        body: formatGiteaPrMentionReply(
          'active_follow_up',
          tryBuildTaskLink({
            taskId: activeOwner.taskId,
            campaign: 'gitea.pr.mention.active-owner',
          }),
        ),
      });

      return { status: 'ok', message: 'active_pr_owner_routed' };
    }

    console.warn(
      `[handleGiteaComment] failed to deliver PR mention to reusable task ${activeOwner.taskId}: ${delivery.error}`,
    );
  }

  const headSha = pullRequest.head?.sha ?? '';

  if (headSha) {
    const activeReview = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber: pullRequest.number,
      headSha,
    });

    if (activeReview?.taskId) {
      await postPullRequestMentionResponseComment({
        ...mentionResponseTarget,
        body: formatGiteaPrMentionReply(
          'active_review',
          tryBuildTaskLink({
            taskId: activeReview.taskId,
            campaign: 'gitea.pr.mention.review.active',
          }),
        ),
      });

      return { status: 'ok', message: 'active_pr_review_linked' };
    }
  }

  const prUrl =
    pullRequest.html_url ??
    pullRequest.url ??
    `${payload.repository.html_url ?? ''}/pulls/${pullRequest.number}`;
  const reviewPayload = {
    repo: repoFullName,
    sourceControlProvider: 'gitea',
    // Pin repository resolution to the webhook repository's host so
    // same-name repositories on other hosts cannot be picked up. Legacy
    // rows without a recorded host omit the field.
    ...(target.repo.host ? { sourceControlHost: target.repo.host } : {}),
    prNumber: pullRequest.number,
    prTitle: pullRequest.title,
    prUrl,
    headSha,
    branchName: pullRequest.head?.ref,
    ...(pullRequest.head?.ref ? { branch: pullRequest.head.ref } : {}),
    ...(headSha ? { sha: headSha } : {}),
    targetBranch: pullRequest.base?.ref,
  } satisfies TaskPayload<typeof TaskPayloadKind.GithubPrReview>;

  try {
    // A human @roomote mention started this review: the commenter is the
    // initiator (the old automatic/gitea attribution override is gone).
    const launch = await enqueueTask({
      task: {
        type: TaskPayloadKind.GithubPrReview,
        payload: reviewPayload,
      },
      initiator: { kind: 'user', userId: target.userId },
      workflow: 'pr_review',
      surface: 'gitea',
      trigger: 'message',
      prLinkage: {
        provider: 'gitea',
        ...(target.repo.host ? { host: target.repo.host } : {}),
        repositoryId: target.repo.id,
        repository: repoFullName,
        prNumber: pullRequest.number,
        prUrl,
        prTitle: pullRequest.title,
        prSha: headSha || null,
        prBaseRef: pullRequest.base?.ref ?? null,
        prBaseSha: pullRequest.base?.sha ?? null,
      },
    });

    await postPullRequestMentionResponseComment({
      ...mentionResponseTarget,
      body: formatGiteaPrMentionReply(
        'review_started',
        tryBuildTaskLink({
          taskId: launch.taskId,
          campaign: 'gitea.pr.mention.review',
        }),
      ),
    });

    return { status: 'ok', metadata: { ids: [launch.id] } };
  } catch (error) {
    console.warn(
      `[handleGiteaComment] failed to start PR review task for ${repoFullName}#${pullRequest.number}: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postPullRequestMentionResponseComment({
      ...mentionResponseTarget,
      body: buildTaskStartFailedComment('pull request'),
    });

    return {
      status: 'error',
      message: `review_start_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function handleGiteaComment(
  payload: GiteaPullRequestCommentWebhook,
  options: HandleGiteaCommentOptions = {},
): Promise<WebhookResponse> {
  if (payload.action !== 'created') {
    return {
      status: 'ok',
      message: `unsupported_comment_action:${payload.action}`,
    };
  }

  if (!isGiteaMention(payload.comment.body)) {
    return { status: 'ok', message: 'no_mention' };
  }

  const commenter =
    getGiteaUsername(payload.comment.user) ?? getGiteaUsername(payload.sender);

  if (!commenter) {
    return { status: 'ok', message: 'no_comment_author' };
  }

  if (
    isRoomoteGiteaUsername(commenter) ||
    (await isDeploymentTokenAuthor([payload.comment.user, payload.sender]))
  ) {
    return { status: 'ok', message: 'roomote_authored_comment' };
  }

  const repoFullName = payload.repository.full_name;
  const isPullRequestComment =
    options.forcePullRequestComment === true || payload.is_pull === true;

  if (!isPullRequestComment) {
    const issue = resolveGiteaCommentIssue(payload);

    if (!issue) {
      return { status: 'ok', message: 'missing_issue_context' };
    }

    return handleGiteaIssueComment({
      payload,
      commenter,
      repoFullName,
      issue,
    });
  }

  const pullRequest = resolveGiteaCommentPullRequest(payload);

  if (!pullRequest) {
    return { status: 'ok', message: 'missing_pull_request_context' };
  }

  return handleGiteaPullRequestComment({
    payload,
    commenter,
    repoFullName,
    pullRequest,
  });
}

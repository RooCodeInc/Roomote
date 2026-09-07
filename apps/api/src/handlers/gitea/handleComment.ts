import {
  createGiteaIssueComment,
  createGiteaPullRequestComment,
  getGiteaDeploymentUser,
} from '@roomote/gitea';
import { PRODUCT_NAME } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
import {
  getGiteaAutomationTargets,
  getGiteaUsername,
  isRoomoteGiteaUsername,
} from './getGiteaAutomationTargets';
import { toHostFromUrl } from '../utils';
import type { GiteaPullRequestCommentWebhook } from './types';
import {
  startSourceControlFastSessionTurn,
  type SourceControlFastDiscussion,
} from '@roomote/sdk/server';
import {
  buildSourceControlIssueMentionContext,
  buildSourceControlPullRequestMentionContext,
  resolveSourceControlIssueActiveTasks,
  resolveSourceControlPullRequestActiveTasks,
  SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE,
} from '../shared/source-control-mention';

const GITEA_MENTION_HANDLE = '@roomote';

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

function buildReviewerGateMissComment(): string {
  return `I saw the mention, but I could not start work on this pull request with the current ${PRODUCT_NAME} Gitea setup.`;
}

function buildIssueGateMissComment(): string {
  return `I saw the mention, but I could not start work on this issue with the current ${PRODUCT_NAME} Gitea setup.`;
}

function commentMessageId(
  payload: GiteaPullRequestCommentWebhook,
  fallback: string,
): string {
  return `gitea:comment:${payload.comment.id ?? `${fallback}:${Date.now()}`}`;
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
  const webhookHost = toHostFromUrl(
    issue.html_url ?? issue.url ?? payload.repository.html_url ?? '',
  );

  // Skip pr_review automation gates. Issue mentions only need a linked sender
  // and a mapped environment.
  const targetsResult = await getGiteaAutomationTargets({
    workflow: 'pr_conflict_resolve',
    payload: {
      repository: payload.repository,
      sender: payload.sender,
      commentAuthor: payload.comment.user,
    },
    webhookHost,
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
          ? await buildSourceControlAccountLinkRequiredMessage('gitea')
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

  const discussion: SourceControlFastDiscussion = {
    provider: 'gitea',
    host: target.repo.host ?? webhookHost ?? 'gitea',
    repositoryFullName: repoFullName,
    kind: 'issues',
    number: issue.number,
  };
  const activeTasks = await resolveSourceControlIssueActiveTasks({
    provider: 'gitea',
    repositoryFullName: repoFullName,
    issueNumber: issue.number,
    host: discussion.host,
  });

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: target.userId,
    senderDisplayName: commenter,
    question: payload.comment.body,
    agentContext: buildSourceControlIssueMentionContext({
      providerLabel: 'Gitea',
      issueLabel: 'Issue',
      repositoryFullName: repoFullName,
      number: issue.number,
      title: issue.title ?? `Issue #${issue.number}`,
      body: issue.body ?? null,
      url:
        issue.html_url ??
        issue.url ??
        (payload.repository.html_url
          ? `${payload.repository.html_url}/issues/${issue.number}`
          : null),
      authorLogin: getGiteaUsername(issue.user) ?? null,
      commenter,
      commentBody: payload.comment.body,
    }),
    currentMessageId: commentMessageId(payload, String(issue.number)),
    activeTasks,
  });

  if (started.status !== 'queued') {
    await postIssueMentionResponseComment({
      ...mentionResponseTarget,
      body: SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE,
    });
    return { status: 'error', message: 'fast_unavailable' };
  }

  return {
    status: 'ok',
    message: 'fast_session_queued',
    metadata: { fastConversationId: started.fastConversationId },
  };
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
  const webhookHost = toHostFromUrl(
    pullRequest.html_url ??
      pullRequest.url ??
      payload.repository.html_url ??
      '',
  );

  const targetsResult = await getGiteaAutomationTargets({
    workflow: 'pr_review',
    payload: {
      repository: payload.repository,
      sender: payload.sender,
      commentAuthor: payload.comment.user,
    },
    webhookHost,
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  if (!target || !target.userId) {
    await postPullRequestMentionResponseComment({
      ...mentionResponseTarget,
      body:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? await buildSourceControlAccountLinkRequiredMessage('gitea')
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
  const headSha = pullRequest.head?.sha ?? '';
  const discussion: SourceControlFastDiscussion = {
    provider: 'gitea',
    host: target.repo.host ?? webhookHost ?? 'gitea',
    repositoryFullName: repoFullName,
    kind: 'pull',
    number: pullRequest.number,
  };
  const activeTasks = await resolveSourceControlPullRequestActiveTasks({
    provider: 'gitea',
    repositoryFullName: repoFullName,
    prNumber: pullRequest.number,
    branchName,
    headSha,
    host: discussion.host,
  });

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: target.userId,
    senderDisplayName: commenter,
    question: payload.comment.body,
    agentContext: buildSourceControlPullRequestMentionContext({
      providerLabel: 'Gitea',
      pullRequestLabel: 'Pull request',
      repositoryFullName: repoFullName,
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? null,
      headRef: branchName || null,
      baseRef: pullRequest.base?.ref ?? null,
      authorLogin: getGiteaUsername(pullRequest.user) ?? null,
      commenter,
      commentBody: payload.comment.body,
    }),
    currentMessageId: commentMessageId(payload, String(pullRequest.number)),
    activeTasks,
  });

  if (started.status !== 'queued') {
    await postPullRequestMentionResponseComment({
      ...mentionResponseTarget,
      body: SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE,
    });
    return { status: 'error', message: 'fast_unavailable' };
  }

  return {
    status: 'ok',
    message: 'fast_session_queued',
    metadata: { fastConversationId: started.fastConversationId },
  };
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

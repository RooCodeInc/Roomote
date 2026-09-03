import {
  createAdoPullRequestComment,
  getAdoDeploymentUser,
  type AdoCurrentUser,
} from '@roomote/ado';
import { PRODUCT_NAME } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { toHostFromUrl } from '../utils';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
import {
  startSourceControlFastSessionTurn,
  type SourceControlFastDiscussion,
} from '@roomote/sdk/server';
import {
  buildSourceControlPullRequestMentionContext,
  resolveSourceControlPullRequestActiveTasks,
  SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE,
} from '../shared/source-control-mention';
import {
  getAdoAutomationTargets,
  getAdoIdentityName,
  isRoomoteAdoIdentity,
} from './getAdoAutomationTargets';
import {
  getAdoPullRequestHeadSha,
  getAdoPullRequestRepositoryFullName,
  getAdoPullRequestUrl,
  stripAdoGitRefPrefix,
} from './pullRequestMetadata';
import type {
  AdoIdentity,
  AdoPullRequestComment,
  AdoPullRequestCommentWebhook,
  AdoPullRequestResource,
} from './types';

const ADO_MENTION_HANDLE = '@roomote';

function isAdoMention(commentBody: string | undefined): boolean {
  return commentBody?.toLowerCase().includes(ADO_MENTION_HANDLE) ?? false;
}

function getThreadId(comment: AdoPullRequestComment): string | undefined {
  if (comment.threadId != null) {
    return String(comment.threadId);
  }

  const hrefs = [comment._links?.threads?.href, comment._links?.self?.href];

  for (const href of hrefs) {
    const match = href?.match(/\/threads\/([^/?#]+)/i);

    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  return undefined;
}

function getDeploymentIdentityNames(user: AdoCurrentUser | null): string[] {
  if (!user) {
    return [];
  }

  return [user.uniqueName, user.displayName, user.providerDisplayName].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

async function isDeploymentTokenAuthor(author: AdoIdentity): Promise<boolean> {
  try {
    const deploymentUser = await getAdoDeploymentUser();

    if (!deploymentUser) {
      return false;
    }

    if (author.id && deploymentUser.id === author.id) {
      return true;
    }

    const authorName = getAdoIdentityName(author)?.toLowerCase();

    return Boolean(
      authorName &&
      getDeploymentIdentityNames(deploymentUser).some(
        (deploymentName) => deploymentName.toLowerCase() === authorName,
      ),
    );
  } catch (error) {
    console.warn(
      `[handleAdoComment] failed to resolve Azure DevOps deployment token identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return false;
  }
}

async function postMentionResponseComment({
  repoFullName,
  pullRequest,
  comment,
  body,
}: {
  repoFullName: string;
  pullRequest: AdoPullRequestResource;
  comment: AdoPullRequestComment;
  body: string;
}): Promise<void> {
  try {
    await createAdoPullRequestComment({
      repositoryFullName: repoFullName,
      repositoryId: pullRequest.repository.id,
      pullRequestNumber: pullRequest.pullRequestId,
      threadId: getThreadId(comment),
      parentCommentId: comment.id,
      body,
    });
  } catch (error) {
    console.warn(
      `[handleAdoComment] failed to post mention response comment on ${repoFullName}#${pullRequest.pullRequestId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildReviewerGateMissComment(): string {
  return `I saw the mention, but I could not start work on this pull request with the current ${PRODUCT_NAME} Azure DevOps setup.`;
}

/**
 * Every @roomote comment on a pull request enters that pull request's Fast
 * Session. Replies stay in the comment thread the mention came from.
 */
export async function handleAdoComment(
  payload: AdoPullRequestCommentWebhook,
): Promise<WebhookResponse> {
  const comment = payload.resource.comment;
  const pullRequest = payload.resource.pullRequest;

  if (comment.commentType && comment.commentType.toLowerCase() !== 'text') {
    return {
      status: 'ok',
      message: `unsupported_comment_type:${comment.commentType}`,
    };
  }

  if (!isAdoMention(comment.content)) {
    return { status: 'ok', message: 'no_mention' };
  }

  const author = comment.author;
  const commenter = getAdoIdentityName(author);

  if (!author || !commenter) {
    return { status: 'ok', message: 'no_comment_author' };
  }

  if (
    isRoomoteAdoIdentity(commenter) ||
    (await isDeploymentTokenAuthor(author))
  ) {
    return { status: 'ok', message: 'roomote_authored_comment' };
  }

  const repoFullName = getAdoPullRequestRepositoryFullName({
    resourceContainers: payload.resourceContainers,
    pullRequest,
  });
  const mentionResponseTarget = {
    repoFullName,
    pullRequest,
    comment,
  };
  const prUrl = getAdoPullRequestUrl({
    resourceContainers: payload.resourceContainers,
    pullRequest,
    repositoryFullName: repoFullName,
  });
  const webhookHost = toHostFromUrl(prUrl);
  const targetsResult = await getAdoAutomationTargets({
    workflow: 'pr_review',
    payload: {
      resource: pullRequest,
      repositoryFullName: repoFullName,
      commentAuthor: author,
    },
    // The PR web URL (or the account/collection base URL it is built from)
    // carries the instance host, matching repositories.host.
    webhookHost,
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });
  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  // requireLinkedSenderAccount guarantees a linked commenter here.
  if (!target || !target.userId) {
    const body =
      targetsResult.status === 'error' &&
      targetsResult.code === 'account_link_required'
        ? await buildSourceControlAccountLinkRequiredMessage('ado')
        : buildReviewerGateMissComment();

    await postMentionResponseComment({ ...mentionResponseTarget, body });

    return {
      status: 'ok',
      message:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? 'account_link_required'
          : 'reviewer_gate_miss',
    };
  }

  const branchName = stripAdoGitRefPrefix(pullRequest.sourceRefName) ?? '';
  const headSha = getAdoPullRequestHeadSha(pullRequest);
  const threadId = getThreadId(comment);
  const discussion: SourceControlFastDiscussion = {
    provider: 'ado',
    host: target.repo.host ?? webhookHost ?? 'dev.azure.com',
    repositoryFullName: repoFullName,
    kind: 'pull',
    number: pullRequest.pullRequestId,
    ...(threadId ? { reviewCommentId: threadId } : {}),
    ...(threadId && comment.id !== undefined
      ? { replyCommentId: String(comment.id) }
      : {}),
  };
  const activeTasks = await resolveSourceControlPullRequestActiveTasks({
    provider: 'ado',
    repositoryFullName: repoFullName,
    prNumber: pullRequest.pullRequestId,
    branchName,
    headSha,
  });

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: target.userId,
    senderDisplayName: commenter,
    question: comment.content ?? '',
    agentContext: buildSourceControlPullRequestMentionContext({
      providerLabel: 'Azure DevOps',
      pullRequestLabel: 'Pull request',
      repositoryFullName: repoFullName,
      number: pullRequest.pullRequestId,
      title: pullRequest.title,
      body: pullRequest.description ?? null,
      headRef: branchName || null,
      baseRef: stripAdoGitRefPrefix(pullRequest.targetRefName) ?? null,
      authorLogin: getAdoIdentityName(pullRequest.createdBy) ?? null,
      commenter,
      commentBody: comment.content ?? '',
    }),
    currentMessageId: `ado:comment:${comment.id ?? `${pullRequest.pullRequestId}:${Date.now()}`}`,
    activeTasks,
  });

  if (started.status !== 'queued') {
    await postMentionResponseComment({
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

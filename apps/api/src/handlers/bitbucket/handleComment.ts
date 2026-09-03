import { createBitbucketPullRequestComment } from '@roomote/bitbucket';
import {
  startSourceControlFastSessionTurn,
  type SourceControlFastDiscussion,
} from '@roomote/sdk/server';
import {
  buildSourceControlPullRequestMentionContext,
  resolveSourceControlPullRequestActiveTasks,
  SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE,
} from '../shared/source-control-mention';
import { PRODUCT_NAME } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { toHostFromUrl } from '../utils';
import {
  buildSourceControlAccountLinkRequiredMessage,
  buildSourceControlEnvironmentRequiredMessage,
} from '../source-control-account-linking';
import {
  getBitbucketAutomationTargets,
  getBitbucketUsername,
  isRoomoteBitbucketUsername,
} from './getBitbucketAutomationTargets';
import {
  getBitbucketCommentBody,
  getBitbucketPullRequestBaseRef,
  getBitbucketPullRequestHeadRef,
  getBitbucketPullRequestHeadSha,
  getBitbucketPullRequestNumber,
  getBitbucketPullRequestUrl,
  type BitbucketPullRequestCommentWebhook,
} from './types';

const BITBUCKET_MENTION_HANDLE = '@roomote';

function isBitbucketMention(commentBody: string): boolean {
  return commentBody.toLowerCase().includes(BITBUCKET_MENTION_HANDLE);
}

async function postMentionResponseComment({
  repositoryFullName,
  pullRequestNumber,
  body,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  body: string;
}): Promise<void> {
  try {
    await createBitbucketPullRequestComment({
      repositoryFullName,
      pullRequestNumber,
      body,
    });
    console.info(
      `[handleBitbucketComment] posted mention response comment on ${repositoryFullName}#${pullRequestNumber}`,
    );
  } catch (error) {
    console.warn(
      `[handleBitbucketComment] failed to post mention response comment on ${repositoryFullName}#${pullRequestNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );

    throw error;
  }
}

function buildReviewerGateMissComment(): string {
  return `I saw the mention, but I could not start work on this pull request with the current ${PRODUCT_NAME} Bitbucket setup.`;
}

/**
 * Every @roomote comment on a pull request enters that pull request's Fast
 * Session. The Session reads the discussion, replies as a comment, and
 * delegates work on the source branch when the request needs a task.
 */
export async function handleBitbucketComment(
  payload: BitbucketPullRequestCommentWebhook,
  eventName: string,
): Promise<WebhookResponse> {
  if (eventName !== 'pullrequest:comment_created') {
    return {
      status: 'ok',
      message: `unsupported_comment_event:${eventName}`,
    };
  }

  const commentBody = getBitbucketCommentBody(payload.comment);

  if (!isBitbucketMention(commentBody)) {
    return { status: 'ok', message: 'no_mention' };
  }

  const commenter =
    getBitbucketUsername(payload.comment.user) ??
    getBitbucketUsername(payload.actor);

  if (!commenter) {
    return { status: 'ok', message: 'no_comment_author' };
  }

  if (isRoomoteBitbucketUsername(commenter)) {
    return { status: 'ok', message: 'roomote_authored_comment' };
  }

  const repoFullName = payload.repository.full_name;
  const pullRequest = payload.pullrequest;
  const prNumber = getBitbucketPullRequestNumber(pullRequest);
  const headRef = getBitbucketPullRequestHeadRef(pullRequest);
  const headSha = getBitbucketPullRequestHeadSha(pullRequest);
  const baseRef = getBitbucketPullRequestBaseRef(pullRequest);
  const prUrl = getBitbucketPullRequestUrl(payload);
  const webhookHost = toHostFromUrl(prUrl);

  const mentionResponseTarget = {
    repositoryFullName: repoFullName,
    pullRequestNumber: prNumber,
  };

  const targetsResult = await getBitbucketAutomationTargets({
    workflow: 'pr_review',
    payload: {
      repository: payload.repository,
      actor: payload.actor,
      commentAuthor: payload.comment.user,
    },
    // The PR web URL carries the instance host, matching repositories.host.
    webhookHost,
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  if (targetsResult.status === 'error') {
    console.warn('[handleBitbucketComment] automation target rejected', {
      repository: repoFullName,
      pullRequestNumber: prNumber,
      code: targetsResult.code ?? null,
      reason: targetsResult.message,
    });
  }

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  const requiresEnvironment =
    targetsResult.status === 'error' &&
    targetsResult.message.includes('no environment mapping');
  const requiresAccountLink =
    targetsResult.status === 'error' &&
    targetsResult.code === 'account_link_required';

  if (!target || !target.userId) {
    await postMentionResponseComment({
      ...mentionResponseTarget,
      body: requiresAccountLink
        ? await buildSourceControlAccountLinkRequiredMessage('bitbucket')
        : requiresEnvironment
          ? buildSourceControlEnvironmentRequiredMessage('bitbucket')
          : buildReviewerGateMissComment(),
    });

    return {
      status: 'ok',
      message: requiresAccountLink
        ? 'account_link_required'
        : requiresEnvironment
          ? 'environment_required'
          : 'reviewer_gate_miss',
    };
  }

  const discussion: SourceControlFastDiscussion = {
    provider: 'bitbucket',
    host: target.repo.host ?? webhookHost ?? 'bitbucket.org',
    repositoryFullName: repoFullName,
    kind: 'pull',
    number: prNumber,
  };
  const activeTasks = await resolveSourceControlPullRequestActiveTasks({
    provider: 'bitbucket',
    repositoryFullName: repoFullName,
    prNumber,
    branchName: headRef ?? '',
    headSha: headSha ?? '',
    host: target.repo.host ?? null,
  });

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: target.userId,
    senderDisplayName:
      payload.comment.user?.display_name ??
      payload.actor?.display_name ??
      commenter,
    question: commentBody,
    agentContext: buildSourceControlPullRequestMentionContext({
      providerLabel: 'Bitbucket',
      pullRequestLabel: 'Pull request',
      repositoryFullName: repoFullName,
      number: prNumber,
      title: pullRequest.title,
      body: pullRequest.description ?? null,
      headRef: headRef ?? null,
      baseRef: baseRef ?? null,
      authorLogin: getBitbucketUsername(pullRequest.author) ?? null,
      commenter,
      commentBody,
    }),
    currentMessageId: `bitbucket:comment:${payload.comment.id ?? `${prNumber}:${Date.now()}`}`,
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

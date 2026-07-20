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
  createAdoPullRequestComment,
  getAdoDeploymentUser,
  type AdoCurrentUser,
} from '@roomote/ado';
import {
  type TaskPayload,
  TaskPayloadKind,
  PRODUCT_NAME,
  isActivelyRunningTask,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { toHostFromUrl } from '../utils';
import {
  sendMessageToTask,
  steerMessageToTask,
} from '../tasks/sendMessageToTask';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
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

type AdoPrMentionReplyKind =
  | 'active_follow_up'
  | 'active_review'
  | 'review_started';

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
      utm: { source: 'ado-comment', campaign },
    });
  } catch (error) {
    console.warn(
      `[handleAdoComment] failed to build task link for ${taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}

function formatAdoPrMentionReply(
  kind: AdoPrMentionReplyKind,
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

function buildReviewerGateMissComment(): string {
  return `I saw the mention, but I could not start work on this pull request with the current ${PRODUCT_NAME} Azure DevOps setup.`;
}

function buildTaskStartFailedComment(): string {
  return 'I saw the mention, but I could not start a task for this pull request right now. Please try again in a moment.';
}

function buildExistingTaskFollowUpMessage({
  repoFullName,
  pullRequest,
  commenter,
  commentBody,
}: {
  repoFullName: string;
  pullRequest: AdoPullRequestResource;
  commenter: string;
  commentBody: string;
}): string {
  const lines = [
    `${commenter} mentioned Roomote in a comment on Azure DevOps pull request #${pullRequest.pullRequestId} (${escapeTaskContextText(pullRequest.title)}) in ${repoFullName}.`,
    '',
    'Please act on this comment as a follow-up to your existing work on this pull request.',
  ];
  const branchName = stripAdoGitRefPrefix(pullRequest.sourceRefName);

  if (branchName) {
    lines.push(`The pull request source branch is \`${branchName}\`.`);
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
  const targetsResult = await getAdoAutomationTargets({
    workflow: 'pr_review',
    payload: {
      resource: pullRequest,
      repositoryFullName: repoFullName,
      commentAuthor: author,
    },
    // The PR web URL (or the account/collection base URL it is built from)
    // carries the instance host, matching repositories.host.
    webhookHost: toHostFromUrl(
      getAdoPullRequestUrl({
        resourceContainers: payload.resourceContainers,
        pullRequest,
        repositoryFullName: repoFullName,
      }),
    ),
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
        ? buildSourceControlAccountLinkRequiredMessage('ado')
        : buildReviewerGateMissComment();

    await postMentionResponseComment({
      ...mentionResponseTarget,
      body,
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

  const branchName = stripAdoGitRefPrefix(pullRequest.sourceRefName) ?? '';
  const activeOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName,
    prNumber: pullRequest.pullRequestId,
    branchName,
    sourceControlProvider: 'ado',
  });

  if (activeOwner?.taskId) {
    const followUpMessage = buildExistingTaskFollowUpMessage({
      repoFullName,
      pullRequest,
      commenter,
      commentBody: comment.content ?? '',
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
      await postMentionResponseComment({
        ...mentionResponseTarget,
        body: formatAdoPrMentionReply(
          'active_follow_up',
          tryBuildTaskLink({
            taskId: activeOwner.taskId,
            campaign: 'ado.pr.mention.active-owner',
          }),
        ),
      });

      return { status: 'ok', message: 'active_pr_owner_routed' };
    }

    console.warn(
      `[handleAdoComment] failed to deliver PR mention to reusable task ${activeOwner.taskId}: ${delivery.error}`,
    );
  }

  const headSha = getAdoPullRequestHeadSha(pullRequest);

  if (headSha) {
    const activeReview = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber: pullRequest.pullRequestId,
      headSha,
    });

    if (activeReview?.taskId) {
      await postMentionResponseComment({
        ...mentionResponseTarget,
        body: formatAdoPrMentionReply(
          'active_review',
          tryBuildTaskLink({
            taskId: activeReview.taskId,
            campaign: 'ado.pr.mention.review.active',
          }),
        ),
      });

      return { status: 'ok', message: 'active_pr_review_linked' };
    }
  }

  const reviewPayload = {
    repo: repoFullName,
    sourceControlProvider: 'ado',
    // Pin repository resolution to the webhook repository's host so
    // same-name repositories on other hosts cannot be picked up. Legacy
    // rows without a recorded host omit the field.
    ...(target.repo.host ? { sourceControlHost: target.repo.host } : {}),
    prNumber: pullRequest.pullRequestId,
    prTitle: pullRequest.title,
    prUrl: getAdoPullRequestUrl({
      resourceContainers: payload.resourceContainers,
      pullRequest,
      repositoryFullName: repoFullName,
    }),
    headSha,
    branchName,
    ...(branchName ? { branch: branchName } : {}),
    ...(headSha ? { sha: headSha } : {}),
    targetBranch: stripAdoGitRefPrefix(pullRequest.targetRefName),
  } satisfies TaskPayload<typeof TaskPayloadKind.GithubPrReview>;

  try {
    // A human @roomote mention started this review: the commenter is the
    // initiator (the old automatic/ado attribution override is gone).
    const launch = await enqueueTask({
      task: {
        type: TaskPayloadKind.GithubPrReview,
        payload: reviewPayload,
      },
      initiator: { kind: 'user', userId: target.userId },
      workflow: 'pr_review',
      surface: 'ado',
      trigger: 'message',
      prLinkage: {
        provider: 'ado',
        ...(target.repo.host ? { host: target.repo.host } : {}),
        repositoryId: target.repo.id,
        repository: repoFullName,
        prNumber: pullRequest.pullRequestId,
        prUrl: reviewPayload.prUrl,
        prTitle: pullRequest.title,
        prSha: headSha || null,
        prBaseRef: stripAdoGitRefPrefix(pullRequest.targetRefName) ?? null,
      },
    });

    await postMentionResponseComment({
      ...mentionResponseTarget,
      body: formatAdoPrMentionReply(
        'review_started',
        tryBuildTaskLink({
          taskId: launch.taskId,
          campaign: 'ado.pr.mention.review',
        }),
      ),
    });

    return { status: 'ok', metadata: { ids: [launch.id] } };
  } catch (error) {
    console.warn(
      `[handleAdoComment] failed to start PR review task for ${repoFullName}#${pullRequest.pullRequestId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    await postMentionResponseComment({
      ...mentionResponseTarget,
      body: buildTaskStartFailedComment(),
    });

    return {
      status: 'error',
      message: `review_start_failed:${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

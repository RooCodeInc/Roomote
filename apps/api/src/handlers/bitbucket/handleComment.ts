import { enqueueTask, getTaskUrl } from '@roomote/cloud-agents/server';
import {
  findActiveGitHubPrReviewTask,
  findReusableGitHubPrFollowUpOwner,
} from '@roomote/db/server';
import {
  createBitbucketPullRequestComment,
  getBitbucketDeploymentUser,
  normalizeBitbucketLinkedAccountKey,
} from '@roomote/bitbucket';
import {
  type TaskPayload,
  TaskPayloadKind,
  PRODUCT_NAME,
  isActivelyRunningTask,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
import {
  sendMessageToTask,
  steerMessageToTask,
} from '../tasks/sendMessageToTask';
import {
  getBitbucketAutomationTargets,
  getBitbucketUserAccountKey,
  getBitbucketUsername,
  isRoomoteBitbucketUsername,
} from './getBitbucketAutomationTargets';
import {
  getBitbucketCommentBody,
  getBitbucketPullRequestBaseRef,
  getBitbucketPullRequestBaseSha,
  getBitbucketPullRequestHeadRef,
  getBitbucketPullRequestHeadSha,
  getBitbucketPullRequestNumber,
  getBitbucketPullRequestUrl,
  type BitbucketPullRequestCommentWebhook,
  type BitbucketWebhookUser,
} from './types';

const BITBUCKET_MENTION_HANDLE = '@roomote';

type BitbucketPrMentionReplyKind =
  | 'active_follow_up'
  | 'active_review'
  | 'review_started';

function isBitbucketMention(commentBody: string): boolean {
  return commentBody.toLowerCase().includes(BITBUCKET_MENTION_HANDLE);
}

async function isDeploymentTokenAuthor(
  author: BitbucketWebhookUser | undefined,
): Promise<boolean> {
  try {
    const deploymentUser = await getBitbucketDeploymentUser();

    if (!deploymentUser) {
      return false;
    }

    const authorKey = getBitbucketUserAccountKey(author);

    if (authorKey) {
      if (
        deploymentUser.accountId &&
        normalizeBitbucketLinkedAccountKey(deploymentUser.accountId) ===
          authorKey
      ) {
        return true;
      }

      if (
        deploymentUser.uuid &&
        normalizeBitbucketLinkedAccountKey(deploymentUser.uuid) === authorKey
      ) {
        return true;
      }
    }

    const username = getBitbucketUsername(author);

    return (
      !!username &&
      deploymentUser.login.toLowerCase() === username.toLowerCase()
    );
  } catch (error) {
    console.warn(
      `[handleBitbucketComment] failed to resolve Bitbucket deployment token identity: ${error instanceof Error ? error.message : String(error)}`,
    );

    return false;
  }
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
  } catch (error) {
    console.warn(
      `[handleBitbucketComment] failed to post mention response comment on ${repositoryFullName}#${pullRequestNumber}: ${error instanceof Error ? error.message : String(error)}`,
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
      utm: { source: 'bitbucket-comment', campaign },
    });
  } catch (error) {
    console.warn(
      `[handleBitbucketComment] failed to build task link for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return null;
  }
}

function formatBitbucketPrMentionReply(
  kind: BitbucketPrMentionReplyKind,
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
  return `I saw the mention, but I could not start work on this pull request with the current ${PRODUCT_NAME} Bitbucket setup.`;
}

function buildTaskStartFailedComment(): string {
  return 'I saw the mention, but I could not start a task for this pull request right now. Please try again in a moment.';
}

function formatQuotedText(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function buildExistingTaskFollowUpMessage({
  repoFullName,
  pullRequestNumber,
  pullRequestTitle,
  headRef,
  commenter,
  commentBody,
}: {
  repoFullName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  headRef?: string;
  commenter: string;
  commentBody: string;
}): string {
  const lines = [
    `${commenter} mentioned Roomote in a comment on Bitbucket pull request #${pullRequestNumber} (${pullRequestTitle}) in ${repoFullName}:`,
    formatQuotedText(commentBody),
    '',
    'Please act on this comment as a follow-up to your existing work on this pull request.',
  ];

  if (headRef) {
    lines.push(`The pull request source branch is \`${headRef}\`.`);
  }

  return lines.join('\n');
}

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

  if (
    isRoomoteBitbucketUsername(commenter) ||
    (await isDeploymentTokenAuthor(payload.comment.user ?? payload.actor))
  ) {
    return { status: 'ok', message: 'roomote_authored_comment' };
  }

  const repoFullName = payload.repository.full_name;
  const pullRequest = payload.pullrequest;
  const prNumber = getBitbucketPullRequestNumber(pullRequest);
  const headRef = getBitbucketPullRequestHeadRef(pullRequest);
  const headSha = getBitbucketPullRequestHeadSha(pullRequest);
  const baseRef = getBitbucketPullRequestBaseRef(pullRequest);
  const baseSha = getBitbucketPullRequestBaseSha(pullRequest);

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
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  if (!target || !target.userId) {
    await postMentionResponseComment({
      ...mentionResponseTarget,
      body:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? buildSourceControlAccountLinkRequiredMessage('bitbucket')
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

  const activeOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName,
    prNumber,
    branchName: headRef ?? '',
    sourceControlProvider: 'bitbucket',
  });

  if (activeOwner?.taskId) {
    const followUpMessage = buildExistingTaskFollowUpMessage({
      repoFullName,
      pullRequestNumber: prNumber,
      pullRequestTitle: pullRequest.title,
      headRef,
      commenter,
      commentBody,
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
        body: formatBitbucketPrMentionReply(
          'active_follow_up',
          tryBuildTaskLink({
            taskId: activeOwner.taskId,
            campaign: 'bitbucket.pr.mention.active-owner',
          }),
        ),
      });

      return { status: 'ok', message: 'active_pr_owner_routed' };
    }

    console.warn(
      `[handleBitbucketComment] failed to deliver PR mention to reusable task ${activeOwner.taskId}: ${delivery.error}`,
    );
  }

  if (headSha) {
    const activeReview = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha,
      sourceControlProvider: 'bitbucket',
    });

    if (activeReview?.taskId) {
      await postMentionResponseComment({
        ...mentionResponseTarget,
        body: formatBitbucketPrMentionReply(
          'active_review',
          tryBuildTaskLink({
            taskId: activeReview.taskId,
            campaign: 'bitbucket.pr.mention.review.active',
          }),
        ),
      });

      return { status: 'ok', message: 'active_pr_review_linked' };
    }
  }

  const prUrl = getBitbucketPullRequestUrl(payload);
  const reviewPayload = {
    repo: repoFullName,
    sourceControlProvider: 'bitbucket',
    // Pin repository resolution to the webhook repository's host so
    // same-name repositories on other hosts cannot be picked up. Legacy
    // rows without a recorded host omit the field.
    ...(target.repo.host ? { sourceControlHost: target.repo.host } : {}),
    prNumber,
    prTitle: pullRequest.title,
    prUrl,
    headSha,
    branchName: headRef,
    ...(headRef ? { branch: headRef } : {}),
    ...(headSha ? { sha: headSha } : {}),
    targetBranch: baseRef,
  } satisfies TaskPayload<typeof TaskPayloadKind.GithubPrReview>;

  try {
    const launch = await enqueueTask({
      task: {
        type: TaskPayloadKind.GithubPrReview,
        payload: reviewPayload,
      },
      initiator: { kind: 'user', userId: target.userId },
      workflow: 'pr_review',
      surface: 'bitbucket',
      trigger: 'message',
      prLinkage: {
        provider: 'bitbucket',
        repository: repoFullName,
        prNumber,
        prUrl,
        prTitle: pullRequest.title,
        prSha: headSha || null,
        prBaseRef: baseRef ?? null,
        prBaseSha: baseSha ?? null,
      },
    });

    await postMentionResponseComment({
      ...mentionResponseTarget,
      body: formatBitbucketPrMentionReply(
        'review_started',
        tryBuildTaskLink({
          taskId: launch.taskId,
          campaign: 'bitbucket.pr.mention.review',
        }),
      ),
    });

    return { status: 'ok', metadata: { ids: [launch.id] } };
  } catch (error) {
    console.warn(
      `[handleBitbucketComment] failed to start PR review task for ${repoFullName}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postMentionResponseComment({
      ...mentionResponseTarget,
      body: buildTaskStartFailedComment(),
    });

    return {
      status: 'error',
      message: `review_start_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

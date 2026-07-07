import { enqueueCloudTask, getTaskUrl } from '@roomote/cloud-agents/server';
import {
  findActiveGitHubPrReviewTask,
  findReusableGitHubPrFollowUpOwner,
} from '@roomote/db/server';
import {
  createGitLabMergeRequestNote,
  getGitLabDeploymentUser,
} from '@roomote/gitlab';
import {
  type CloudTaskPayload,
  CloudAgentType,
  CloudTaskType,
  PRODUCT_NAME,
  isActivelyRunningCloudTask,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';
import {
  sendMessageToTask,
  steerMessageToTask,
} from '../tasks/sendMessageToTask';
import {
  getGitLabAutomationTargets,
  isRoomoteGitLabUsername,
} from './getGitLabAutomationTargets';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
import type { GitLabNoteWebhook } from './types';

const GITLAB_MENTION_HANDLE = '@roomote';

// Project/group access tokens author notes as `project_<id>_bot_<suffix>`
// service accounts. Worker-posted MR notes use those identities, so treat
// them as Roomote-authored to avoid mention loops.
const GITLAB_RESOURCE_BOT_USERNAME_PATTERN = /^(project|group)_\d+_bot/i;

type GitLabMrMentionReplyKind =
  | 'active_follow_up'
  | 'active_review'
  | 'review_started';

function isGitLabMention(noteBody: string): boolean {
  return noteBody.toLowerCase().includes(GITLAB_MENTION_HANDLE);
}

function isGitLabRoomoteAuthoredNote(username: string): boolean {
  return (
    isRoomoteGitLabUsername(username) ||
    GITLAB_RESOURCE_BOT_USERNAME_PATTERN.test(username)
  );
}

async function isDeploymentTokenAuthor(username: string): Promise<boolean> {
  try {
    const deploymentUser = await getGitLabDeploymentUser();

    return (
      !!deploymentUser &&
      deploymentUser.username.toLowerCase() === username.toLowerCase()
    );
  } catch (error) {
    console.warn(
      `[handleGitLabNote] failed to resolve GitLab deployment token identity: ${error instanceof Error ? error.message : String(error)}`,
    );

    return false;
  }
}

async function postMentionResponseNote({
  projectId,
  mergeRequestIid,
  body,
}: {
  projectId: number;
  mergeRequestIid: number;
  body: string;
}): Promise<void> {
  try {
    await createGitLabMergeRequestNote({
      projectId,
      mergeRequestIid,
      body,
    });
  } catch (error) {
    console.warn(
      `[handleGitLabNote] failed to post mention response note on project ${projectId} MR !${mergeRequestIid}: ${error instanceof Error ? error.message : String(error)}`,
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
      utm: { source: 'gitlab-note', campaign },
    });
  } catch (error) {
    console.warn(
      `[handleGitLabNote] failed to build task link for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return null;
  }
}

function formatGitLabMrMentionReply(
  kind: GitLabMrMentionReplyKind,
  link: string | null,
): string {
  const replyCopy = (() => {
    switch (kind) {
      case 'active_follow_up':
        return {
          intro:
            "I'm on it. I routed this request into the existing task for this merge request so follow-up work stays on one Roomote thread, and I'll keep updates here.",
          fallback:
            'I could not generate the task link for this note, but the follow-up was delivered.',
        };
      case 'active_review':
        return {
          intro:
            'I found a merge request review already running for this request, and I will keep updates here.',
          fallback:
            'I could not generate the task link for this note, but the review is already in progress.',
        };
      case 'review_started':
        return {
          intro:
            'I started a merge request review task for this request, and I will keep updates here.',
          fallback:
            'I could not generate the task link for this note, but the review task is already running.',
        };
    }
  })();

  if (!link) {
    return `${replyCopy.intro} ${replyCopy.fallback}`;
  }

  return `${replyCopy.intro} [See task](${link})`;
}

function buildReviewerGateMissNote(): string {
  return `I saw the mention, but I could not start work on this merge request with the current ${PRODUCT_NAME} GitLab setup.`;
}

function buildTaskStartFailedNote(): string {
  return 'I saw the mention, but I could not start a task for this merge request right now. Please try again in a moment.';
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
  mergeRequest,
  commenter,
  noteBody,
}: {
  repoFullName: string;
  mergeRequest: NonNullable<GitLabNoteWebhook['merge_request']>;
  commenter: string;
  noteBody: string;
}): string {
  const lines = [
    `${commenter} mentioned Roomote in a comment on GitLab merge request !${mergeRequest.iid} (${mergeRequest.title}) in ${repoFullName}:`,
    formatQuotedText(noteBody),
    '',
    'Please act on this comment as a follow-up to your existing work on this merge request.',
  ];

  if (mergeRequest.source_branch) {
    lines.push(
      `The merge request source branch is \`${mergeRequest.source_branch}\`.`,
    );
  }

  return lines.join('\n');
}

export async function handleGitLabNote(
  payload: GitLabNoteWebhook,
): Promise<WebhookResponse> {
  const note = payload.object_attributes;
  const mergeRequest = payload.merge_request;

  if (note.action && note.action !== 'create') {
    return { status: 'ok', message: `unsupported_note_action:${note.action}` };
  }

  // System notes are GitLab-generated activity (label changes, cross-references,
  // "mentioned in ..." echoes). They can restate a user's @roomote text without
  // being a real request, so never treat them as mentions.
  if (note.system) {
    return { status: 'ok', message: 'system_note' };
  }

  if (note.noteable_type !== 'MergeRequest' || !mergeRequest) {
    return {
      status: 'ok',
      message: `unsupported_noteable_type:${note.noteable_type}`,
    };
  }

  if (!isGitLabMention(note.note)) {
    return { status: 'ok', message: 'no_mention' };
  }

  const commenter = payload.user?.username;

  if (!commenter) {
    return { status: 'ok', message: 'no_note_author' };
  }

  if (
    isGitLabRoomoteAuthoredNote(commenter) ||
    (await isDeploymentTokenAuthor(commenter))
  ) {
    return { status: 'ok', message: 'roomote_authored_note' };
  }

  const repoFullName = payload.project.path_with_namespace;

  if (!repoFullName) {
    return { status: 'error', message: 'missing_project_path_with_namespace' };
  }

  const mentionResponseTarget = {
    projectId: payload.project.id,
    mergeRequestIid: mergeRequest.iid,
  };

  const targetsResult = await getGitLabAutomationTargets({
    type: CloudAgentType.PrReviewer,
    payload,
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  if (!target) {
    await postMentionResponseNote({
      ...mentionResponseTarget,
      body:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? buildSourceControlAccountLinkRequiredMessage('gitlab')
          : buildReviewerGateMissNote(),
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

  const branchName = mergeRequest.source_branch ?? '';

  const activeOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName,
    prNumber: mergeRequest.iid,
    branchName,
    sourceControlProvider: 'gitlab',
  });

  if (activeOwner?.taskId) {
    const followUpMessage = buildExistingTaskFollowUpMessage({
      repoFullName,
      mergeRequest,
      commenter,
      noteBody: note.note,
    });
    const delivery = isActivelyRunningCloudTask(
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
      await postMentionResponseNote({
        ...mentionResponseTarget,
        body: formatGitLabMrMentionReply(
          'active_follow_up',
          tryBuildTaskLink({
            taskId: activeOwner.taskId,
            campaign: 'gitlab.mr.mention.active-owner',
          }),
        ),
      });

      return { status: 'ok', message: 'active_mr_owner_routed' };
    }

    console.warn(
      `[handleGitLabNote] failed to deliver MR mention to reusable task ${activeOwner.taskId}: ${delivery.error}`,
    );
  }

  const headSha = mergeRequest.last_commit?.id ?? '';

  // Dedup against a review already running for this MR head, mirroring GitHub's
  // handlePrComment. Without this, a mention on an MR that already has an active
  // review — or two mentions in quick succession — would enqueue a duplicate
  // review task and post a second acknowledgement note.
  if (headSha) {
    const activeReview = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber: mergeRequest.iid,
      headSha,
    });

    if (activeReview?.taskId) {
      await postMentionResponseNote({
        ...mentionResponseTarget,
        body: formatGitLabMrMentionReply(
          'active_review',
          tryBuildTaskLink({
            taskId: activeReview.taskId,
            campaign: 'gitlab.mr.mention.review.active',
          }),
        ),
      });

      return { status: 'ok', message: 'active_mr_review_linked' };
    }
  }

  const prUrl =
    mergeRequest.url ??
    (payload.project.web_url
      ? `${payload.project.web_url}/-/merge_requests/${mergeRequest.iid}`
      : '');

  const reviewPayload = {
    repo: repoFullName,
    sourceControlProvider: 'gitlab',
    prNumber: mergeRequest.iid,
    prTitle: mergeRequest.title,
    prUrl,
    headSha,
    branchName: mergeRequest.source_branch,
    ...(mergeRequest.source_branch
      ? { branch: mergeRequest.source_branch }
      : {}),
    ...(headSha ? { sha: headSha } : {}),
    targetBranch: mergeRequest.target_branch,
  } satisfies CloudTaskPayload<CloudTaskType.GithubPrReview>;

  try {
    const launch = await enqueueCloudTask(
      {
        userId: target.userId,
        attributionOverride: {
          kind: 'automatic',
          sourceKind: 'gitlab',
        },
        type: CloudTaskType.GithubPrReview,
        payload: reviewPayload,
      },
      {
        launchClass: 'automation',
      },
    );

    await postMentionResponseNote({
      ...mentionResponseTarget,
      body: formatGitLabMrMentionReply(
        'review_started',
        tryBuildTaskLink({
          taskId: launch.taskId,
          campaign: 'gitlab.mr.mention.review',
        }),
      ),
    });

    return { status: 'ok', metadata: { ids: [launch.id] } };
  } catch (error) {
    console.warn(
      `[handleGitLabNote] failed to start MR review task for ${repoFullName}!${mergeRequest.iid}: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postMentionResponseNote({
      ...mentionResponseTarget,
      body: buildTaskStartFailedNote(),
    });

    return {
      status: 'error',
      message: `review_start_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

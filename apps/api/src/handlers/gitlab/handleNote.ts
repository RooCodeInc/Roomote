import {
  buildMentionRequestBlock,
  buildUntrustedContentPolicy,
  buildUntrustedExternalContentBlock,
  enqueueTask,
  escapeTaskContextText,
  getTaskUrl,
} from '@roomote/cloud-agents/server';
import {
  db,
  environmentRepositoryMappings,
  eq,
  asc,
  findActiveGitHubPrReviewTask,
  findReusableGitHubIssueTaskOwner,
  findReusableGitHubPrFollowUpOwner,
} from '@roomote/db/server';
import {
  createGitLabIssueNote,
  createGitLabMergeRequestNote,
  getGitLabDeploymentUser,
} from '@roomote/gitlab';
import {
  type TaskPayload,
  TaskPayloadKind,
  PRODUCT_NAME,
  isActivelyRunningTask,
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
import {
  buildSourceControlAccountLinkRequiredMessage,
  buildSourceControlEnvironmentRequiredMessage,
} from '../source-control-account-linking';
import { toHostFromUrl } from '../utils';
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

type GitLabIssueMentionReplyKind = 'active_follow_up' | 'task_started';

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

async function postMergeRequestMentionResponseNote({
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

async function postIssueMentionResponseNote({
  projectId,
  issueIid,
  body,
}: {
  projectId: number;
  issueIid: number;
  body: string;
}): Promise<void> {
  try {
    await createGitLabIssueNote({
      projectId,
      issueIid,
      body,
    });
  } catch (error) {
    console.warn(
      `[handleGitLabNote] failed to post mention response note on project ${projectId} issue #${issueIid}: ${error instanceof Error ? error.message : String(error)}`,
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

function formatGitLabIssueMentionReply(
  kind: GitLabIssueMentionReplyKind,
  link: string | null,
): string {
  const replyCopy = (() => {
    switch (kind) {
      case 'active_follow_up':
        return {
          intro:
            "I'm on it. I routed this request into the existing task for this issue so follow-up work stays on one Roomote thread, and I'll keep updates here.",
          fallback:
            'I could not generate the task link for this note, but the follow-up was delivered.',
        };
      case 'task_started':
        return {
          intro:
            "I'm on it. I started a task for this issue, and I'll keep updates here.",
          fallback:
            'I could not generate the task link for this note, but the task is already running.',
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

function buildIssueGateMissNote(): string {
  return `I saw the mention, but I could not start work on this issue with the current ${PRODUCT_NAME} GitLab setup.`;
}

function buildTaskStartFailedNote(surface: 'merge request' | 'issue'): string {
  return `I saw the mention, but I could not start a task for this ${surface} right now. Please try again in a moment.`;
}

function formatQuotedText(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function buildExistingMrTaskFollowUpMessage({
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

function buildIssueMentionPrompt({
  repositoryFullName,
  issueIid,
  issueTitle,
  issueBody,
  issueUrl,
  commentBody,
  commenterLogin,
}: {
  repositoryFullName: string;
  issueIid: number;
  issueTitle: string;
  issueBody?: string | null;
  issueUrl: string;
  commentBody: string;
  commenterLogin: string;
}): string {
  const trimmedIssueBody = issueBody?.trim() ?? '';
  const trimmedCommentBody = commentBody.trim();
  const issueBodySection =
    trimmedIssueBody && trimmedIssueBody !== trimmedCommentBody
      ? [
          '',
          'Issue description (context only):',
          buildUntrustedExternalContentBlock({
            source: 'gitlab_issue_description',
            text: trimmedIssueBody,
          }),
        ]
      : [];

  return [
    `${commenterLogin} mentioned Roomote on GitLab issue #${issueIid} (${escapeTaskContextText(issueTitle)}) in ${repositoryFullName}.`,
    `Issue URL: ${issueUrl}`,
    '',
    'Mention comment (the request to act on):',
    buildMentionRequestBlock(trimmedCommentBody),
    ...issueBodySection,
    '',
    buildUntrustedContentPolicy(),
  ].join('\n');
}

function buildIssueFollowUpMessage({
  repositoryFullName,
  issueIid,
  issueTitle,
  issueUrl,
  commentBody,
  commenterLogin,
}: {
  repositoryFullName: string;
  issueIid: number;
  issueTitle: string;
  issueUrl: string;
  commentBody: string;
  commenterLogin: string;
}): string {
  return [
    `${commenterLogin} mentioned Roomote again on GitLab issue #${issueIid} (${escapeTaskContextText(issueTitle)}) in ${repositoryFullName}.`,
    `Issue URL: ${issueUrl}`,
    '',
    'This is a follow-up on the existing Roomote task for this issue. Continue that work instead of starting a separate task.',
    '',
    'Mention comment (the request to act on):',
    buildMentionRequestBlock(commentBody),
    '',
    buildUntrustedContentPolicy(),
  ].join('\n');
}

async function resolveMappedEnvironmentId(
  repositoryId: string,
): Promise<string | null> {
  const mappings = await db
    .select({
      environmentId: environmentRepositoryMappings.environmentId,
    })
    .from(environmentRepositoryMappings)
    .where(eq(environmentRepositoryMappings.repositoryId, repositoryId))
    .orderBy(asc(environmentRepositoryMappings.environmentId));

  if (mappings.length === 0) {
    return null;
  }

  return mappings[0]?.environmentId ?? null;
}

async function handleGitLabIssueNote({
  payload,
  note,
  issue,
  commenter,
  repoFullName,
}: {
  payload: GitLabNoteWebhook;
  note: GitLabNoteWebhook['object_attributes'];
  issue: NonNullable<GitLabNoteWebhook['issue']>;
  commenter: string;
  repoFullName: string;
}): Promise<WebhookResponse> {
  const mentionResponseTarget = {
    projectId: payload.project.id,
    issueIid: issue.iid,
  };

  // Skip pr_review automation gates (review enabled / author policy). Issue
  // mentions should only need a linked sender and a mapped environment, matching
  // GitHub issue comment handling.
  const targetsResult = await getGitLabAutomationTargets({
    workflow: 'pr_conflict_resolve',
    payload,
    webhookHost: toHostFromUrl(issue.url ?? payload.project.web_url ?? ''),
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  if (!target || !target.userId) {
    await postIssueMentionResponseNote({
      ...mentionResponseTarget,
      body:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? buildSourceControlAccountLinkRequiredMessage('gitlab')
          : buildIssueGateMissNote(),
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

  const environmentId = await resolveMappedEnvironmentId(target.repo.id);

  if (!environmentId) {
    await postIssueMentionResponseNote({
      ...mentionResponseTarget,
      body: buildSourceControlEnvironmentRequiredMessage('gitlab'),
    });

    return { status: 'ok', message: 'environment_required' };
  }

  const issueUrl =
    issue.url ??
    (payload.project.web_url
      ? `${payload.project.web_url}/-/issues/${issue.iid}`
      : '');
  const issueTitle = issue.title ?? `Issue #${issue.iid}`;
  const issueBody = issue.description ?? null;

  const existingIssueOwner = await findReusableGitHubIssueTaskOwner({
    repoFullName,
    issueNumber: issue.iid,
    sourceControlProvider: 'gitlab',
  });

  if (existingIssueOwner?.taskId) {
    const followUpMessage = buildIssueFollowUpMessage({
      repositoryFullName: repoFullName,
      issueIid: issue.iid,
      issueTitle,
      issueUrl,
      commentBody: note.note,
      commenterLogin: commenter,
    });

    const delivery = isActivelyRunningTask(
      existingIssueOwner.status,
      existingIssueOwner.taskPhase,
    )
      ? await steerMessageToTask({
          taskId: existingIssueOwner.taskId,
          userId: target.userId,
          message: followUpMessage,
          senderMode: 'github_pr_follow_up',
        })
      : await sendMessageToTask({
          taskId: existingIssueOwner.taskId,
          userId: target.userId,
          message: followUpMessage,
          senderMode: 'github_pr_follow_up',
        });

    if (delivery.success) {
      await postIssueMentionResponseNote({
        ...mentionResponseTarget,
        body: formatGitLabIssueMentionReply(
          'active_follow_up',
          tryBuildTaskLink({
            taskId: existingIssueOwner.taskId,
            campaign: 'gitlab.issue.mention.active-owner',
          }),
        ),
      });

      return { status: 'ok', message: 'active_issue_owner_routed' };
    }

    console.warn(
      `[handleGitLabNote] failed to deliver issue mention to reusable task ${existingIssueOwner.taskId}: ${delivery.error}`,
    );
  }

  const prompt = buildIssueMentionPrompt({
    repositoryFullName: repoFullName,
    issueIid: issue.iid,
    issueTitle,
    issueBody,
    issueUrl,
    commentBody: note.note,
    commenterLogin: commenter,
  });

  const taskPayload = {
    repo: repoFullName,
    sourceControlProvider: 'gitlab',
    ...(target.repo.host ? { sourceControlHost: target.repo.host } : {}),
    environmentId,
    selectedRepositories: [repoFullName],
    description: prompt,
    linkedWorkItems: [
      {
        provider: 'gitlab',
        identifier: String(issue.iid),
        url: issueUrl,
        title: issueTitle,
        repository: repoFullName,
      },
    ],
  } satisfies TaskPayload<typeof TaskPayloadKind.StandardTask>;

  try {
    const launch = await enqueueTask({
      task: {
        type: TaskPayloadKind.StandardTask,
        payload: taskPayload,
      },
      initiator: { kind: 'user', userId: target.userId },
      workflow: 'standard',
      surface: 'gitlab',
      trigger: 'message',
    });

    await postIssueMentionResponseNote({
      ...mentionResponseTarget,
      body: formatGitLabIssueMentionReply(
        'task_started',
        tryBuildTaskLink({
          taskId: launch.taskId,
          campaign: 'gitlab.issue.mention',
        }),
      ),
    });

    return {
      status: 'ok',
      metadata: { ids: [launch.id] },
    };
  } catch (error) {
    console.warn(
      `[handleGitLabNote] failed to start issue task for ${repoFullName}#${issue.iid}: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postIssueMentionResponseNote({
      ...mentionResponseTarget,
      body: buildTaskStartFailedNote('issue'),
    });

    return {
      status: 'error',
      message: `issue_task_start_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleGitLabMergeRequestNote({
  payload,
  note,
  mergeRequest,
  commenter,
  repoFullName,
}: {
  payload: GitLabNoteWebhook;
  note: GitLabNoteWebhook['object_attributes'];
  mergeRequest: NonNullable<GitLabNoteWebhook['merge_request']>;
  commenter: string;
  repoFullName: string;
}): Promise<WebhookResponse> {
  const mentionResponseTarget = {
    projectId: payload.project.id,
    mergeRequestIid: mergeRequest.iid,
  };

  const targetsResult = await getGitLabAutomationTargets({
    workflow: 'pr_review',
    payload,
    // The MR (or project) web URL carries the instance host, matching
    // repositories.host.
    webhookHost: toHostFromUrl(
      mergeRequest.url ?? payload.project.web_url ?? '',
    ),
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  // requireLinkedSenderAccount guarantees a linked commenter here.
  if (!target || !target.userId) {
    await postMergeRequestMentionResponseNote({
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
    const followUpMessage = buildExistingMrTaskFollowUpMessage({
      repoFullName,
      mergeRequest,
      commenter,
      noteBody: note.note,
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
      await postMergeRequestMentionResponseNote({
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
      await postMergeRequestMentionResponseNote({
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
    // Pin repository resolution to the webhook repository's host so
    // same-name repositories on other hosts cannot be picked up. Legacy
    // rows without a recorded host omit the field.
    ...(target.repo.host ? { sourceControlHost: target.repo.host } : {}),
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
  } satisfies TaskPayload<typeof TaskPayloadKind.GithubPrReview>;

  try {
    // A human @roomote mention started this review: the commenter is the
    // initiator (the old automatic/gitlab attribution override is gone).
    const launch = await enqueueTask({
      task: {
        type: TaskPayloadKind.GithubPrReview,
        payload: reviewPayload,
      },
      initiator: { kind: 'user', userId: target.userId },
      workflow: 'pr_review',
      surface: 'gitlab',
      trigger: 'message',
      prLinkage: {
        provider: 'gitlab',
        ...(target.repo.host ? { host: target.repo.host } : {}),
        repositoryId: target.repo.id,
        repository: repoFullName,
        prNumber: mergeRequest.iid,
        prUrl,
        prTitle: mergeRequest.title,
        prSha: headSha || null,
        prBaseRef: mergeRequest.target_branch ?? null,
      },
    });

    await postMergeRequestMentionResponseNote({
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

    await postMergeRequestMentionResponseNote({
      ...mentionResponseTarget,
      body: buildTaskStartFailedNote('merge request'),
    });

    return {
      status: 'error',
      message: `review_start_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function handleGitLabNote(
  payload: GitLabNoteWebhook,
): Promise<WebhookResponse> {
  const note = payload.object_attributes;
  const mergeRequest = payload.merge_request;
  const issue = payload.issue;

  if (note.action && note.action !== 'create') {
    return { status: 'ok', message: `unsupported_note_action:${note.action}` };
  }

  // System notes are GitLab-generated activity (label changes, cross-references,
  // "mentioned in ..." echoes). They can restate a user's @roomote text without
  // being a real request, so never treat them as mentions.
  if (note.system) {
    return { status: 'ok', message: 'system_note' };
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

  if (note.noteable_type === 'Issue' && issue) {
    return handleGitLabIssueNote({
      payload,
      note,
      issue,
      commenter,
      repoFullName,
    });
  }

  if (note.noteable_type === 'MergeRequest' && mergeRequest) {
    return handleGitLabMergeRequestNote({
      payload,
      note,
      mergeRequest,
      commenter,
      repoFullName,
    });
  }

  return {
    status: 'ok',
    message: `unsupported_noteable_type:${note.noteable_type}`,
  };
}

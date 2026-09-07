import {
  createGitLabIssueNote,
  createGitLabMergeRequestNote,
  getGitLabDeploymentUser,
} from '@roomote/gitlab';
import {
  startSourceControlFastSessionTurn,
  type SourceControlFastDiscussion,
} from '@roomote/sdk/server';
import { PRODUCT_NAME } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
import {
  buildSourceControlIssueMentionContext,
  buildSourceControlPullRequestMentionContext,
  resolveSourceControlIssueActiveTasks,
  resolveSourceControlPullRequestActiveTasks,
  SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE,
} from '../shared/source-control-mention';
import {
  getGitLabAutomationTargets,
  isRoomoteGitLabUsername,
} from './getGitLabAutomationTargets';
import { toHostFromUrl } from '../utils';
import type { GitLabNoteWebhook } from './types';

const GITLAB_MENTION_HANDLE = '@roomote';

// Project/group access tokens author notes as `project_<id>_bot_<suffix>`
// service accounts. Worker-posted MR notes use those identities, so treat
// them as Roomote-authored to avoid mention loops.
const GITLAB_RESOURCE_BOT_USERNAME_PATTERN = /^(project|group)_\d+_bot/i;

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
    await createGitLabMergeRequestNote({ projectId, mergeRequestIid, body });
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
    await createGitLabIssueNote({ projectId, issueIid, body });
  } catch (error) {
    console.warn(
      `[handleGitLabNote] failed to post mention response note on project ${projectId} issue #${issueIid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildReviewerGateMissNote(): string {
  return `I saw the mention, but I could not start work on this merge request with the current ${PRODUCT_NAME} GitLab setup.`;
}

function buildIssueGateMissNote(): string {
  return `I saw the mention, but I could not start work on this issue with the current ${PRODUCT_NAME} GitLab setup.`;
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
  const webhookHost = toHostFromUrl(issue.url ?? payload.project.web_url ?? '');

  // Skip pr_review automation gates (review enabled / author policy). Issue
  // mentions only need a linked sender and a mapped environment.
  const targetsResult = await getGitLabAutomationTargets({
    workflow: 'pr_conflict_resolve',
    payload,
    webhookHost,
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
          ? await buildSourceControlAccountLinkRequiredMessage('gitlab')
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

  const host = target.repo.host ?? webhookHost ?? 'gitlab.com';
  const discussion: SourceControlFastDiscussion = {
    provider: 'gitlab',
    host,
    repositoryFullName: repoFullName,
    kind: 'issues',
    number: issue.iid,
  };
  const activeTasks = await resolveSourceControlIssueActiveTasks({
    provider: 'gitlab',
    repositoryFullName: repoFullName,
    issueNumber: issue.iid,
    host: discussion.host,
  });

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: target.userId,
    senderDisplayName: payload.user?.name ?? commenter,
    question: note.note,
    agentContext: buildSourceControlIssueMentionContext({
      providerLabel: 'GitLab',
      issueLabel: 'Issue',
      repositoryFullName: repoFullName,
      number: issue.iid,
      title: issue.title,
      body: issue.description ?? null,
      url:
        issue.url ??
        (payload.project.web_url
          ? `${payload.project.web_url}/-/issues/${issue.iid}`
          : null),
      commenter,
      commentBody: note.note,
    }),
    currentMessageId: `gitlab:note:${note.id ?? `${issue.iid}:${Date.now()}`}`,
    activeTasks,
  });

  if (started.status !== 'queued') {
    await postIssueMentionResponseNote({
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
  const webhookHost = toHostFromUrl(
    mergeRequest.url ?? payload.project.web_url ?? '',
  );

  const targetsResult = await getGitLabAutomationTargets({
    workflow: 'pr_review',
    payload,
    webhookHost,
    ignoreAuthorPolicy: true,
    requireLinkedSenderAccount: true,
  });

  const target =
    targetsResult.status === 'ok' ? targetsResult.targets[0] : undefined;

  if (!target || !target.userId) {
    await postMergeRequestMentionResponseNote({
      ...mentionResponseTarget,
      body:
        targetsResult.status === 'error' &&
        targetsResult.code === 'account_link_required'
          ? await buildSourceControlAccountLinkRequiredMessage('gitlab')
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
  const headSha = mergeRequest.last_commit?.id ?? '';
  const host = target.repo.host ?? webhookHost ?? 'gitlab.com';
  const discussion: SourceControlFastDiscussion = {
    provider: 'gitlab',
    host,
    repositoryFullName: repoFullName,
    kind: 'pull',
    number: mergeRequest.iid,
  };
  const activeTasks = await resolveSourceControlPullRequestActiveTasks({
    provider: 'gitlab',
    repositoryFullName: repoFullName,
    prNumber: mergeRequest.iid,
    branchName,
    headSha,
    host: discussion.host,
  });

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: target.userId,
    senderDisplayName: payload.user?.name ?? commenter,
    question: note.note,
    agentContext: buildSourceControlPullRequestMentionContext({
      providerLabel: 'GitLab',
      pullRequestLabel: 'Merge request',
      repositoryFullName: repoFullName,
      number: mergeRequest.iid,
      title: mergeRequest.title,
      body: mergeRequest.description ?? null,
      headRef: branchName || null,
      baseRef: mergeRequest.target_branch ?? null,
      commenter,
      commentBody: note.note,
    }),
    currentMessageId: `gitlab:note:${note.id ?? `${mergeRequest.iid}:${Date.now()}`}`,
    activeTasks,
  });

  if (started.status !== 'queued') {
    await postMergeRequestMentionResponseNote({
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

/**
 * Every @roomote note on a merge request or issue enters that discussion's
 * Fast Session. The Session reads the discussion, replies as a note, and
 * delegates work when the request needs a task.
 */
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

import type { FastAgentActiveTask } from '@roomote/cloud-agents/server';
import { findReusableGitHubIssueTaskOwner } from '@roomote/db/server';
import { getInstallationOctokit } from '@roomote/github';
import {
  startSourceControlFastSessionTurn,
  type SourceControlFastDiscussion,
} from '@roomote/sdk/server';
import { PRODUCT_NAME } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
import { getGitHubAutomationTargets } from './getGitHubAutomationTargets';
import { isMention } from './isMention';
import {
  fetchGitHubLinkedReferences,
  formatGitHubLinkedReferencesSection,
} from './linked-issue-pr-context';
import type {
  WebhookIssueCommentCreated,
  WebhookRepository,
  WebhookInstallation,
  WebhookUser,
} from './types';

type IssueMentionIssue = {
  number: number;
  title?: string | null;
  body?: string | null;
  html_url?: string | null;
  pull_request?: unknown;
  user?: { login?: string | null } | null;
};

type IssueMentionPayload = {
  installation?: WebhookInstallation;
  repository: WebhookRepository;
  sender: WebhookUser;
  issue: IssueMentionIssue;
  comment?: WebhookIssueCommentCreated['comment'];
  /**
   * Optional body override for issue-body mentions (`issues.opened`) when
   * there is no comment object.
   */
  mentionBody?: string;
};

const FAST_UNAVAILABLE_COMMENT =
  "I saw the mention, but I couldn't start a conversation right now. Please try again in a moment.";

async function postIssueComment({
  installationId,
  repositoryFullName,
  issueNumber,
  body,
}: {
  installationId: number;
  repositoryFullName: string;
  issueNumber: number;
  body: string;
}): Promise<void> {
  const [owner, repo] = repositoryFullName.split('/');

  if (!owner || !repo) {
    return;
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  } catch (error) {
    console.warn(
      `[handleGitHubIssueComment] failed to post comment on ${repositoryFullName}#${issueNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function acknowledgeIssueMentionBestEffort({
  installationId,
  repositoryFullName,
  commentId,
}: {
  installationId: number;
  repositoryFullName: string;
  commentId: number | undefined;
}): Promise<void> {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo || commentId === undefined) {
    return;
  }
  try {
    const octokit = await getInstallationOctokit({ installationId });
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: 'eyes',
    });
  } catch (error) {
    console.warn(
      `[handleGitHubIssueComment] failed to acknowledge mention on ${repositoryFullName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildGateMissComment(): string {
  return `I saw the mention, but I could not start work on this issue with the current ${PRODUCT_NAME} GitHub setup.`;
}

function formatQuotedText(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * What the Session reads with an issue mention: the issue, the comment that
 * mentioned Roomote (or the issue body when the mention is in it), and any
 * linked pull requests or issues.
 */
function buildIssueMentionContext({
  repositoryFullName,
  issueNumber,
  issueTitle,
  issueBody,
  issueUrl,
  issueAuthorLogin,
  commenterLogin,
  commentBody,
  mentionIsIssueBody,
  linkedReferencesSection,
}: {
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string | null;
  issueUrl: string;
  issueAuthorLogin: string | null;
  commenterLogin: string;
  commentBody: string;
  mentionIsIssueBody: boolean;
  linkedReferencesSection?: string;
}): string {
  const author = issueAuthorLogin ? `@${issueAuthorLogin}` : 'an unknown user';
  return [
    `<github_issue url="${issueUrl}">`,
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} - ${issueTitle}`,
    `Author: ${author}`,
    ...(issueBody?.trim() && !mentionIsIssueBody
      ? ['', 'Body (context only):', formatQuotedText(issueBody)]
      : []),
    '</github_issue>',
    '<triggering_comment>',
    mentionIsIssueBody
      ? `${commenterLogin} mentioned Roomote in the issue body:`
      : `${commenterLogin} mentioned Roomote in a comment on the issue:`,
    formatQuotedText(commentBody),
    '</triggering_comment>',
    ...(linkedReferencesSection ? [linkedReferencesSection] : []),
    'This conversation is a GitHub issue discussion. Your replies post as comments on the issue, so keep them concise. Delegated tasks run in the environment mapped to this repository and link the issue.',
  ].join('\n');
}

/**
 * Every @mention on an issue enters the issue's Fast Session. The Session
 * reads the issue, replies as a comment, and delegates work when the request
 * needs a task.
 */
export async function handleGitHubIssueComment(
  eventPayload: IssueMentionPayload,
): Promise<WebhookResponse> {
  const { installation, repository, sender, issue } = eventPayload;
  const commentBody =
    eventPayload.mentionBody ?? eventPayload.comment?.body ?? '';
  const commentUser =
    eventPayload.comment?.user ?? (sender ? { login: sender.login } : null);

  if (
    !isMention({
      body: commentBody,
      user: commentUser ? { login: commentUser.login } : null,
    })
  ) {
    return { status: 'ok', message: 'no_mention' };
  }

  // Defensive: PR comments must stay on the PR path.
  if ('pull_request' in issue && issue.pull_request) {
    return { status: 'ok', message: 'is_pr_comment' };
  }

  const githubInstallationId = installation?.id;

  if (!githubInstallationId) {
    return { status: 'error', message: 'no_installation' };
  }

  const issueNumber = issue.number;
  const repositoryFullName = repository.full_name;
  const replyTarget = {
    installationId: githubInstallationId,
    repositoryFullName,
    issueNumber,
  };

  const commenterGate = await getGitHubAutomationTargets({
    // Reuse the non-pr_review path so repository + linked-user resolution
    // happens without requiring Review Code automation to be enabled.
    workflow: 'pr_conflict_resolve',
    installation,
    repository,
    sender,
    requireLinkedSenderAccount: true,
  });

  if (commenterGate.status === 'error') {
    await postIssueComment({
      ...replyTarget,
      body:
        commenterGate.code === 'account_link_required'
          ? await buildSourceControlAccountLinkRequiredMessage('github')
          : buildGateMissComment(),
    });

    return {
      status: 'ok',
      message:
        commenterGate.code === 'account_link_required'
          ? 'account_link_required'
          : 'issue_gate_miss',
    };
  }

  const target = commenterGate.targets[0];

  if (!target?.properties.userId) {
    await postIssueComment({
      ...replyTarget,
      body: await buildSourceControlAccountLinkRequiredMessage('github'),
    });

    return { status: 'ok', message: 'account_link_required' };
  }

  await acknowledgeIssueMentionBestEffort({
    installationId: githubInstallationId,
    repositoryFullName,
    commentId: eventPayload.comment?.id,
  });

  const issueUrl =
    issue.html_url ??
    `https://github.com/${repositoryFullName}/issues/${issueNumber}`;
  const issueTitle = issue.title ?? `Issue #${issueNumber}`;
  const discussion: SourceControlFastDiscussion = {
    provider: 'github',
    host: target.repo.host ?? 'github.com',
    repositoryFullName,
    kind: 'issues',
    number: issueNumber,
  };
  const [linkedReferences, existingOwner] = await Promise.all([
    fetchGitHubLinkedReferences({
      installationId: githubInstallationId,
      repositoryFullName,
      issueOrPrNumber: issueNumber,
    }),
    findReusableGitHubIssueTaskOwner({
      repoFullName: repositoryFullName,
      issueNumber,
      // Scoped to this instance so a same-named issue task on another
      // self-hosted host never surfaces here.
      host: discussion.host,
    }).catch(() => null),
  ]);
  const activeTasks: FastAgentActiveTask[] = existingOwner?.taskId
    ? [{ taskId: existingOwner.taskId, status: existingOwner.status }]
    : [];

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: target.properties.userId,
    senderDisplayName: sender.login,
    question: commentBody,
    agentContext: buildIssueMentionContext({
      repositoryFullName,
      issueNumber,
      issueTitle,
      issueBody: issue.body ?? null,
      issueUrl,
      issueAuthorLogin: issue.user?.login ?? null,
      commenterLogin: sender.login,
      commentBody,
      mentionIsIssueBody: eventPayload.mentionBody !== undefined,
      linkedReferencesSection:
        formatGitHubLinkedReferencesSection(linkedReferences),
    }),
    currentMessageId: eventPayload.comment
      ? `github:comment:${eventPayload.comment.id}`
      : `github:issue:${repositoryFullName}#${issueNumber}`,
    activeTasks,
  });

  if (started.status !== 'queued') {
    await postIssueComment({ ...replyTarget, body: FAST_UNAVAILABLE_COMMENT });
    return { status: 'error', message: 'fast_unavailable' };
  }

  return {
    status: 'ok',
    message: 'fast_session_queued',
    metadata: { fastConversationId: started.fastConversationId },
  };
}

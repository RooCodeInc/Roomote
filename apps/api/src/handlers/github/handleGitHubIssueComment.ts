import { getTaskUrl } from '@roomote/cloud-agents/server';
import { getInstallationOctokit } from '@roomote/github';
import { PRODUCT_NAME } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
import { orchestrateIssueMention } from '../shared/issue-mention-orchestration';
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
      utm: {
        source: 'github-comment',
        campaign,
      },
    });
  } catch (error) {
    console.warn(
      `[handleGitHubIssueComment] failed to build task link: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function formatStartedReply(taskLink: string | null): string {
  if (taskLink) {
    return `I'm on it. I started a task for this issue, and I'll keep updates here.\n\n[See task](${taskLink})`;
  }

  return `I'm on it. I started a task for this issue, and I'll keep updates here.`;
}

function formatFollowUpReply(taskLink: string | null): string {
  if (taskLink) {
    return `I'm on it. I routed this request into the existing task for this issue so follow-up work stays on one Roomote thread, and I'll keep updates here.\n\n[See task](${taskLink})`;
  }

  return `I'm on it. I routed this request into the existing task for this issue so follow-up work stays on one Roomote thread, and I'll keep updates here.`;
}

function buildGateMissComment(): string {
  return `I saw the mention, but I could not start work on this issue with the current ${PRODUCT_NAME} GitHub setup.`;
}

function buildStartFailedComment(): string {
  return `I saw the mention, but I could not start a task for this issue right now. Please try again in a moment.`;
}

/**
 * Handle @mentions on plain GitHub issues (not pull requests).
 * Starts a standard task against the issue's repository, or continues an
 * existing task already linked to the same issue.
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
          ? buildSourceControlAccountLinkRequiredMessage('github')
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
      body: buildSourceControlAccountLinkRequiredMessage('github'),
    });

    return { status: 'ok', message: 'account_link_required' };
  }

  const issueUrl =
    issue.html_url ??
    `https://github.com/${repositoryFullName}/issues/${issueNumber}`;
  const issueTitle = issue.title ?? `Issue #${issueNumber}`;
  const issueBody = issue.body ?? null;
  const commenterUserId = target.properties.userId;
  const issueAuthorLogin = issue.user?.login ?? null;
  const linkedReferences = await fetchGitHubLinkedReferences({
    installationId: githubInstallationId,
    repositoryFullName,
    issueOrPrNumber: issueNumber,
  });
  const linkedReferencesSection =
    formatGitHubLinkedReferencesSection(linkedReferences);

  return orchestrateIssueMention({
    provider: 'github',
    logPrefix: '[handleGitHubIssueComment]',
    repositoryId: target.repo.id,
    repositoryFullName,
    issueNumber,
    issueTitle,
    issueBody,
    issueUrl,
    commentBody,
    commenterLogin: sender.login,
    commenterUserId,
    githubLogin: target.properties.githubLogin ?? undefined,
    githubUserId: target.properties.githubUserId ?? undefined,
    followUpCommenterDisplayName: target.properties.githubLogin ?? sender.login,
    retrySandboxBoot: true,
    providerDisplayName: 'GitHub',
    issueBodySource: 'github_issue_body',
    issueBodyContextLabel: `Issue body (context only, authored by ${
      issueAuthorLogin ? `@${issueAuthorLogin}` : 'an unknown user'
    }):`,
    linkedReferencesSection,
    postComment: (body) => postIssueComment({ ...replyTarget, body }),
    formatFollowUpReply,
    formatStartedReply,
    formatStartFailed: buildStartFailedComment,
    tryBuildTaskLink,
  });
}

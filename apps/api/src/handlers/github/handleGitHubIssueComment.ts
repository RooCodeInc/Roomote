import { enqueueTask, getTaskUrl } from '@roomote/cloud-agents/server';
import {
  db,
  environmentRepositoryMappings,
  eq,
  asc,
  findReusableGitHubIssueTaskOwner,
} from '@roomote/db/server';
import { getInstallationOctokit } from '@roomote/github';
import {
  type RunStatus,
  type TaskPayload,
  PRODUCT_NAME,
  TaskPayloadKind,
  isActivelyRunningTask,
  isExitedRunStatus,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';
import {
  buildSourceControlAccountLinkRequiredMessage,
  buildSourceControlEnvironmentRequiredMessage,
} from '../source-control-account-linking';
import { findLatestTaskRun } from '../tasks/helpers';
import {
  sendMessageToTask,
  steerMessageToTask,
} from '../tasks/sendMessageToTask';
import { getGitHubAutomationTargets } from './getGitHubAutomationTargets';
import { isMention } from './isMention';
import type {
  WebhookIssueCommentCreated,
  WebhookRepository,
  WebhookInstallation,
  WebhookUser,
} from './types';

const EXISTING_TASK_WAIT_TIMEOUT_MS = 15_000;
const EXISTING_TASK_WAIT_POLL_MS = 500;

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

function buildIssueMentionPrompt({
  repositoryFullName,
  issueNumber,
  issueTitle,
  issueBody,
  issueUrl,
  commentBody,
  commenterLogin,
}: {
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody?: string | null;
  issueUrl: string;
  commentBody: string;
  commenterLogin: string;
}): string {
  const issueBodySection = issueBody?.trim()
    ? `\n\nIssue body:\n${issueBody.trim()}`
    : '';

  return [
    `${commenterLogin} mentioned Roomote on GitHub issue #${issueNumber} (${issueTitle}) in ${repositoryFullName}.`,
    `Issue URL: ${issueUrl}`,
    issueBodySection,
    '',
    'Mention comment:',
    commentBody.trim(),
  ].join('\n');
}

function buildIssueFollowUpMessage({
  repositoryFullName,
  issueNumber,
  issueTitle,
  issueUrl,
  commentBody,
  commenterLogin,
}: {
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  commentBody: string;
  commenterLogin: string;
}): string {
  return [
    `${commenterLogin} mentioned Roomote again on GitHub issue #${issueNumber} (${issueTitle}) in ${repositoryFullName}.`,
    `Issue URL: ${issueUrl}`,
    '',
    'This is a follow-up on the existing Roomote task for this issue. Continue that work instead of starting a separate task.',
    '',
    'Mention comment:',
    commentBody.trim(),
  ].join('\n');
}

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

  // When multiple environments map to the same repository, pick a stable
  // ordered environment id and still pin the selected repository so the worker
  // has a concrete checkout target.
  return mappings[0]?.environmentId ?? null;
}

async function waitForTaskToAcceptMessages({
  taskId,
  timeoutMs = EXISTING_TASK_WAIT_TIMEOUT_MS,
}: {
  taskId: string;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const latestRun = await findLatestTaskRun(taskId, {
      id: true,
      status: true,
      taskPhase: true,
      sandboxServerUrl: true,
    });

    if (!latestRun || isExitedRunStatus(latestRun.status)) {
      return null;
    }

    if (latestRun.sandboxServerUrl) {
      return latestRun;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, EXISTING_TASK_WAIT_POLL_MS),
    );
  }

  return null;
}

function isRetryableSandboxBootError(result: {
  success: boolean;
  status?: number;
  error?: string;
}): boolean {
  if (result.success || result.status !== 409) {
    return false;
  }

  const error = result.error ?? '';

  return (
    error.includes('no active sandbox') ||
    error.includes('sandbox is still booting')
  );
}

async function deliverIssueFollowUpToExistingTask({
  taskId,
  userId,
  message,
  status,
  taskPhase,
  commenterDisplayName,
}: {
  taskId: string;
  userId: string;
  message: string;
  status: RunStatus;
  taskPhase: string | null;
  commenterDisplayName?: string;
}) {
  const deliver = ({
    status,
    taskPhase,
  }: {
    status: RunStatus;
    taskPhase: string | null;
  }) =>
    isActivelyRunningTask(status, taskPhase)
      ? steerMessageToTask({
          taskId,
          userId,
          message,
          senderMode: 'github_pr_follow_up',
          ...(commenterDisplayName
            ? { workerQuoteUserName: commenterDisplayName }
            : {}),
        })
      : sendMessageToTask({
          taskId,
          userId,
          message,
          senderMode: 'github_pr_follow_up',
          ...(commenterDisplayName
            ? { workerQuoteUserName: commenterDisplayName }
            : {}),
        });

  let attempt = await deliver({ status, taskPhase });

  if (!isRetryableSandboxBootError(attempt)) {
    return attempt;
  }

  const deadline = Date.now() + EXISTING_TASK_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline && isRetryableSandboxBootError(attempt)) {
    // Prefer waiting until a sandbox URL is recorded, then keep retrying while
    // delivery still reports sandbox-boot 409s (URL present, RPC not ready).
    const readyRun = await waitForTaskToAcceptMessages({
      taskId,
      timeoutMs: Math.max(0, deadline - Date.now()),
    });

    if (!readyRun) {
      return attempt;
    }

    attempt = await deliver({
      status: readyRun.status,
      taskPhase: readyRun.taskPhase,
    });

    if (!isRetryableSandboxBootError(attempt)) {
      return attempt;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, EXISTING_TASK_WAIT_POLL_MS),
    );
  }

  return attempt;
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

  const environmentId = await resolveMappedEnvironmentId(target.repo.id);

  if (!environmentId) {
    await postIssueComment({
      ...replyTarget,
      body: buildSourceControlEnvironmentRequiredMessage('github'),
    });

    return { status: 'ok', message: 'environment_required' };
  }

  const issueUrl =
    issue.html_url ??
    `https://github.com/${repositoryFullName}/issues/${issueNumber}`;
  const issueTitle = issue.title ?? `Issue #${issueNumber}`;
  const issueBody = issue.body ?? null;
  const commenterUserId = target.properties.userId;

  const existingIssueOwner = await findReusableGitHubIssueTaskOwner({
    repoFullName: repositoryFullName,
    issueNumber,
  });

  if (existingIssueOwner?.taskId) {
    const followUpMessage = buildIssueFollowUpMessage({
      repositoryFullName,
      issueNumber,
      issueTitle,
      issueUrl,
      commentBody,
      commenterLogin: sender.login,
    });

    const delivery = await deliverIssueFollowUpToExistingTask({
      taskId: existingIssueOwner.taskId,
      userId: commenterUserId,
      message: followUpMessage,
      status: existingIssueOwner.status,
      taskPhase: existingIssueOwner.taskPhase,
      commenterDisplayName: target.properties.githubLogin ?? sender.login,
    });

    if (delivery.success) {
      await postIssueComment({
        ...replyTarget,
        body: formatFollowUpReply(
          tryBuildTaskLink({
            taskId: existingIssueOwner.taskId,
            campaign: 'github.issue.mention.active-owner',
          }),
        ),
      });

      return { status: 'ok', message: 'active_issue_owner_routed' };
    }

    console.warn(
      `[handleGitHubIssueComment] failed to deliver issue mention to reusable task ${existingIssueOwner.taskId}: ${delivery.error}`,
    );
  }

  const prompt = buildIssueMentionPrompt({
    repositoryFullName,
    issueNumber,
    issueTitle,
    issueBody,
    issueUrl,
    commentBody,
    commenterLogin: sender.login,
  });

  const payload = {
    repo: repositoryFullName,
    environmentId,
    selectedRepositories: [repositoryFullName],
    description: prompt,
    linkedWorkItems: [
      {
        provider: 'github',
        identifier: String(issueNumber),
        url: issueUrl,
        title: issueTitle,
        repository: repositoryFullName,
      },
    ],
  } satisfies TaskPayload<typeof TaskPayloadKind.StandardTask>;

  try {
    const launch = await enqueueTask({
      task: {
        type: TaskPayloadKind.StandardTask,
        githubLogin: target.properties.githubLogin,
        githubUserId: target.properties.githubUserId,
        payload,
      },
      initiator: { kind: 'user', userId: commenterUserId },
      workflow: 'standard',
      surface: 'github',
      trigger: 'message',
    });

    await postIssueComment({
      ...replyTarget,
      body: formatStartedReply(
        tryBuildTaskLink({
          taskId: launch.taskId,
          campaign: 'github.issue.mention',
        }),
      ),
    });

    return {
      status: 'ok',
      metadata: { ids: [launch.id] },
    };
  } catch (error) {
    console.warn(
      `[handleGitHubIssueComment] failed to start issue task for ${repositoryFullName}#${issueNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    await postIssueComment({
      ...replyTarget,
      body: buildStartFailedComment(),
    });

    return {
      status: 'error',
      message: `issue_task_start_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

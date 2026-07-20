import {
  buildMentionRequestBlock,
  buildUntrustedContentPolicy,
  buildUntrustedExternalContentBlock,
  enqueueTask,
  escapeTaskContextText,
} from '@roomote/cloud-agents/server';
import { findReusableGitHubIssueTaskOwner } from '@roomote/db/server';
import {
  type RunStatus,
  type SourceControlProvider,
  type TaskPayload,
  TaskPayloadKind,
  isActivelyRunningTask,
  isExitedRunStatus,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { buildSourceControlEnvironmentRequiredMessage } from '../source-control-account-linking';
import { findLatestTaskRun } from '../tasks/helpers';
import {
  sendMessageToTask,
  steerMessageToTask,
} from '../tasks/sendMessageToTask';
import { resolveMappedEnvironmentId } from './repository-environment';

const EXISTING_TASK_WAIT_TIMEOUT_MS = 15_000;
const EXISTING_TASK_WAIT_POLL_MS = 500;

type IssueMentionProvider = Extract<
  SourceControlProvider,
  'github' | 'gitlab' | 'gitea'
>;

type IssueMentionOrchestrationInput = {
  provider: IssueMentionProvider;
  /** Console warn prefix, e.g. `[handleGitHubIssueComment]`. */
  logPrefix: string;
  repositoryId: string;
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody?: string | null;
  issueUrl: string;
  commentBody: string;
  commenterLogin: string;
  commenterUserId: string;
  sourceControlHost?: string | null;
  /**
   * When true, stamps `sourceControlProvider` (and optional host) on the
   * standard task payload. GitHub omits these for historical payload shape.
   */
  includeSourceControlOnPayload?: boolean;
  githubLogin?: string;
  githubUserId?: number;
  /** Passed through as worker quote identity on follow-up delivery when set. */
  followUpCommenterDisplayName?: string;
  /**
   * Retry follow-up delivery while the sandbox is still booting (409). GitHub
   * historically did this; other providers may opt in.
   */
  retrySandboxBoot?: boolean;
  /** Human provider name in task prompts (“GitHub”, “GitLab”, “Gitea”). */
  providerDisplayName: string;
  /**
   * Untrusted block source id for the issue body/description context section.
   * e.g. `github_issue_body`, `gitlab_issue_description`.
   */
  issueBodySource: string;
  /**
   * Label line above the issue body context block (not including trailing
   * colon-only formatting variations). When null/undefined and there is body
   * context to include, a default is used from `issueBodyContextLabel`.
   */
  issueBodyContextLabel: string;
  postComment: (body: string) => Promise<void>;
  formatFollowUpReply: (taskLink: string | null) => string;
  formatStartedReply: (taskLink: string | null) => string;
  formatStartFailed: () => string;
  tryBuildTaskLink: (params: {
    taskId: string;
    campaign: string;
  }) => string | null;
};

function buildIssueMentionPrompt({
  providerDisplayName,
  repositoryFullName,
  issueNumber,
  issueTitle,
  issueBody,
  issueUrl,
  commentBody,
  commenterLogin,
  issueBodySource,
  issueBodyContextLabel,
}: {
  providerDisplayName: string;
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody?: string | null;
  issueUrl: string;
  commentBody: string;
  commenterLogin: string;
  issueBodySource: string;
  issueBodyContextLabel: string;
}): string {
  const trimmedIssueBody = issueBody?.trim() ?? '';
  const trimmedCommentBody = commentBody.trim();
  // `issues.opened` mentions (GitHub) arrive with the issue body as the mention
  // text, so skip the duplicate issue-body context block when the two match.
  const issueBodySection =
    trimmedIssueBody && trimmedIssueBody !== trimmedCommentBody
      ? [
          '',
          issueBodyContextLabel,
          buildUntrustedExternalContentBlock({
            source: issueBodySource,
            text: trimmedIssueBody,
          }),
        ]
      : [];

  return [
    `${commenterLogin} mentioned Roomote on ${providerDisplayName} issue #${issueNumber} (${escapeTaskContextText(issueTitle)}) in ${repositoryFullName}.`,
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
  providerDisplayName,
  repositoryFullName,
  issueNumber,
  issueTitle,
  issueUrl,
  commentBody,
  commenterLogin,
}: {
  providerDisplayName: string;
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  commentBody: string;
  commenterLogin: string;
}): string {
  return [
    `${commenterLogin} mentioned Roomote again on ${providerDisplayName} issue #${issueNumber} (${escapeTaskContextText(issueTitle)}) in ${repositoryFullName}.`,
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
  retrySandboxBoot,
}: {
  taskId: string;
  userId: string;
  message: string;
  status: RunStatus;
  taskPhase: string | null;
  commenterDisplayName?: string;
  retrySandboxBoot: boolean;
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

  if (!retrySandboxBoot || !isRetryableSandboxBootError(attempt)) {
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
 * Shared issue @mention → task routing after provider-specific gate checks
 * (mention detection, linked sender, PR exclusion) have already succeeded.
 */
export async function orchestrateIssueMention(
  input: IssueMentionOrchestrationInput,
): Promise<WebhookResponse> {
  const {
    provider,
    logPrefix,
    repositoryId,
    repositoryFullName,
    issueNumber,
    issueTitle,
    issueBody,
    issueUrl,
    commentBody,
    commenterLogin,
    commenterUserId,
    sourceControlHost,
    includeSourceControlOnPayload = false,
    githubLogin,
    githubUserId,
    followUpCommenterDisplayName,
    retrySandboxBoot = false,
    providerDisplayName,
    issueBodySource,
    issueBodyContextLabel,
    postComment,
    formatFollowUpReply,
    formatStartedReply,
    formatStartFailed,
    tryBuildTaskLink,
  } = input;

  const environmentId = await resolveMappedEnvironmentId(repositoryId);

  if (!environmentId) {
    await postComment(buildSourceControlEnvironmentRequiredMessage(provider));
    return { status: 'ok', message: 'environment_required' };
  }

  const existingIssueOwner = await findReusableGitHubIssueTaskOwner({
    repoFullName: repositoryFullName,
    issueNumber,
    // GitHub historical call site omitted provider/host (defaults to github).
    ...(provider === 'github'
      ? {}
      : {
          sourceControlProvider: provider,
          host: sourceControlHost ?? null,
        }),
  });

  if (existingIssueOwner?.taskId) {
    const followUpMessage = buildIssueFollowUpMessage({
      providerDisplayName,
      repositoryFullName,
      issueNumber,
      issueTitle,
      issueUrl,
      commentBody,
      commenterLogin,
    });

    const delivery = await deliverIssueFollowUpToExistingTask({
      taskId: existingIssueOwner.taskId,
      userId: commenterUserId,
      message: followUpMessage,
      status: existingIssueOwner.status,
      taskPhase: existingIssueOwner.taskPhase,
      commenterDisplayName: followUpCommenterDisplayName,
      retrySandboxBoot,
    });

    if (delivery.success) {
      await postComment(
        formatFollowUpReply(
          tryBuildTaskLink({
            taskId: existingIssueOwner.taskId,
            campaign: `${provider}.issue.mention.active-owner`,
          }),
        ),
      );

      return { status: 'ok', message: 'active_issue_owner_routed' };
    }

    console.warn(
      `${logPrefix} failed to deliver issue mention to reusable task ${existingIssueOwner.taskId}: ${delivery.error}`,
    );
  }

  const prompt = buildIssueMentionPrompt({
    providerDisplayName,
    repositoryFullName,
    issueNumber,
    issueTitle,
    issueBody,
    issueUrl,
    commentBody,
    commenterLogin,
    issueBodySource,
    issueBodyContextLabel,
  });

  const taskPayload = {
    repo: repositoryFullName,
    ...(includeSourceControlOnPayload
      ? {
          sourceControlProvider: provider,
          ...(sourceControlHost ? { sourceControlHost } : {}),
        }
      : {}),
    environmentId,
    selectedRepositories: [repositoryFullName],
    description: prompt,
    linkedWorkItems: [
      {
        provider,
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
        ...(githubLogin !== undefined ? { githubLogin } : {}),
        ...(githubUserId !== undefined ? { githubUserId } : {}),
        payload: taskPayload,
      },
      initiator: { kind: 'user', userId: commenterUserId },
      workflow: 'standard',
      surface: provider,
      trigger: 'message',
    });

    await postComment(
      formatStartedReply(
        tryBuildTaskLink({
          taskId: launch.taskId,
          campaign: `${provider}.issue.mention`,
        }),
      ),
    );

    return {
      status: 'ok',
      metadata: { ids: [launch.id] },
    };
  } catch (error) {
    console.warn(
      `${logPrefix} failed to start issue task for ${repositoryFullName}#${issueNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    await postComment(formatStartFailed());

    return {
      status: 'error',
      message: `issue_task_start_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

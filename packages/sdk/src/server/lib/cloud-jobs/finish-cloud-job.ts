import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  CloudTaskStatus,
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getEnvironmentDefinitionIdFromPayload,
  parseConflictResolutionSummary,
  stripCloudJobErrorMarkers,
  type TaskState,
} from '@roomote/types';
import {
  formatMarkdownLink,
  TASK_RUNTIME_FAILURE_TEXT,
  TASK_STARTUP_FAILURE_TEXT,
} from '@roomote/communication/chat-messages';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '../teams-communication';
import {
  type CloudJob,
  type Task,
  type TaskPullRequest,
  db,
  taskRuns,
  taskPullRequests,
  deploymentSettings,
  markTaskStartParallelCountEndedAt,
  recordJobLifecycleEvent,
  slackInstallations,
  slackUserMappings,
  asc,
  eq,
  and,
  isNotNull,
  tasks,
} from '@roomote/db/server';
import {
  buildTerminalReviewStatus,
  finalizeGithubPrReviewComment,
  getTaskUrl,
  releaseCloudTask,
  suggestSlackQuestionChannels,
} from '@roomote/cloud-agents/server';
import { captureEvent } from '@roomote/telemetry/server';
import {
  createCloudJobGitHubToken,
  createIssueComment,
  deleteReaction,
  updateCheckRun,
} from '@roomote/github';
import { revokeCloudJobScopedGitLabTokens } from '@roomote/gitlab';
import {
  formatConflictResolutionFailureComment,
  formatConflictResolutionSuccessComment,
  getPersistedConflictResolutionCompletion,
  readConflictResolutionSummary,
} from './conflict-resolution-comments';
import { cleanupSandboxOidcTargetsForCloudJob } from '../sandbox-oidc';
import { refreshTaskTitleOnCompletion } from './record-task-message-envelope';
import { getRedis } from '@roomote/redis';
import { resolveSlackJobRouting } from './slack-job-routing';
import {
  SlackNotifier,
  buildTaskFailedMessage,
  getSlackStartedMessageTs,
  SLACK_RUNTIME_FAILURE_TEXT,
  SLACK_STARTUP_FAILURE_TEXT,
} from '@roomote/slack';
import { LinearClient } from '@roomote/linear';
import { ensureSnapshotResumeGitHubFollowUpFallback } from './ensure-snapshot-resume-github-follow-up-fallback';
import { findLinearDeploymentMcpConnection } from '../mcp/linear-connections';
import { getValidAccessToken } from '../mcp/data';
import {
  findSlackConversationSubjectByUserId,
  recordSlackConversationMessageBestEffort,
} from '../slack-conversation-log';
import { buildManagerSlackSettingsUrl } from '../manager-slack';

const DEFAULT_LOCAL_ROOMOTE_APP_URL = 'http://localhost:13000';
const DEFAULT_DEPLOYMENT_ID = 'default';

/**
 * Run + its owning task, as loaded by the terminal path. Side-effect helpers
 * read conversation cargo (channel bindings, requestedWorkKind, initiator)
 * from `task` and attempt-scoped state from the run row.
 */
type FinishedRun = CloudJob & { task: Task };

function resolveTerminalTaskState(
  status:
    | CloudTaskStatus.Completed
    | CloudTaskStatus.Failed
    | CloudTaskStatus.Canceled,
): TaskState {
  switch (status) {
    case CloudTaskStatus.Completed:
      return 'completed';
    case CloudTaskStatus.Failed:
      return 'failed';
    case CloudTaskStatus.Canceled:
      return 'canceled';
  }
}

export const finishCloudJob = async ({
  id,
  status,
  error,
}: {
  id: number;
  status:
    | CloudTaskStatus.Completed
    | CloudTaskStatus.Failed
    | CloudTaskStatus.Canceled
    | CloudTaskStatus.Idle;
  error?: string;
}) => {
  const job = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, id),
    with: { task: true },
  });

  if (!job) {
    return;
  }

  const task = job.task;

  try {
    await releaseCloudTask(job);
  } catch (error) {
    console.error(
      `[finishCloudJob] Failed to release lock for job ${id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const { payloadKind } = job;
  const sanitizedError = stripCloudJobErrorMarkers(error);

  const now = new Date();
  const existingResult =
    job.result && typeof job.result === 'object' && !Array.isArray(job.result)
      ? (job.result as Record<string, unknown>)
      : {};
  const runtimeTaskId =
    typeof existingResult.runtimeTaskId === 'string'
      ? existingResult.runtimeTaskId
      : null;
  const lifecycleEvent =
    status === CloudTaskStatus.Completed
      ? {
          eventType: 'completed' as const,
          message: 'Cloud job finished successfully.',
        }
      : status === CloudTaskStatus.Failed
        ? {
            eventType: 'failed' as const,
            message: 'Cloud job finished with a failure.',
          }
        : status === CloudTaskStatus.Canceled
          ? {
              eventType: 'decision' as const,
              message: 'Cloud job was canceled.',
            }
          : {
              eventType: 'decision' as const,
              message:
                'Cloud job transitioned to idle while the machine remained alive.',
            };

  await db.transaction(async (tx) => {
    await tx
      .update(taskRuns)
      .set({
        status,
        taskPhase: status === CloudTaskStatus.Idle ? job.taskPhase : null,
        sleepAt: status === CloudTaskStatus.Idle ? job.sleepAt : null,
        error: sanitizedError,
        canceledAt: status === CloudTaskStatus.Canceled ? now : job.canceledAt,
        completedAt: status === CloudTaskStatus.Canceled ? null : now,
      })
      .where(eq(taskRuns.id, id));

    // Terminal task state: this is the only writer of tasks.state. Idle keeps
    // the task active (the sandbox is alive and waiting for interaction).
    if (status !== CloudTaskStatus.Idle) {
      await tx
        .update(tasks)
        .set({
          state: resolveTerminalTaskState(status),
          updatedAt: now,
        })
        .where(eq(tasks.id, job.taskId));
    }

    await markTaskStartParallelCountEndedAt(tx, {
      runId: id,
      endedAt: now,
    });

    await recordJobLifecycleEvent(tx, {
      runId: job.id,
      taskId: job.taskId,
      eventType: lifecycleEvent.eventType,
      message: lifecycleEvent.message,
      details: {
        stage: 'finish_cloud_job',
        status,
        vendor: job.vendor ?? null,
        machineId: job.machineId ?? null,
        sourceSnapshotId: job.sourceSnapshotId ?? null,
        workerReleaseTag: job.workerReleaseTag ?? null,
        workerVersion: job.workerVersion ?? null,
        workerCommit: job.workerCommit ?? null,
        runtimeTaskId,
        previousTaskPhase: job.taskPhase ?? null,
        previousSleepAt: job.sleepAt?.toISOString() ?? null,
        previousSleepRequestedAt: job.sleepRequestedAt?.toISOString() ?? null,
        previousSnapshotRequestedAt:
          job.snapshotRequestedAt?.toISOString() ?? null,
        previousSnapshotCreatedAt: job.snapshotCreatedAt?.toISOString() ?? null,
        previousWorkerHeartbeatAt: job.workerHeartbeatAt?.toISOString() ?? null,
        sleepAt:
          status === CloudTaskStatus.Idle ? job.sleepAt?.toISOString() : null,
        taskPhase: status === CloudTaskStatus.Idle ? job.taskPhase : null,
        error: sanitizedError ?? null,
      },
      createdAt: now,
    });
  });

  // Anonymous analytics (no-op unless enabled): terminal task outcome with
  // non-identifying routing facts only.
  if (status === CloudTaskStatus.Completed) {
    void captureEvent('task_completed', {
      ...(job.actingUserId ? { userId: job.actingUserId } : {}),
      properties: {
        taskType: job.payloadKind,
        harness: job.harness ?? null,
        computeProvider: job.vendor ?? null,
      },
    });
  }

  if (
    status === CloudTaskStatus.Completed ||
    status === CloudTaskStatus.Failed
  ) {
    try {
      await refreshTaskTitleOnCompletion({
        taskId: job.taskId,
        cloudJobId: job.id,
      });
    } catch (error) {
      console.warn(
        `[finishCloudJob] Failed to refresh final title for job ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (status !== CloudTaskStatus.Idle) {
    try {
      await cleanupSandboxOidcTargetsForCloudJob(id);
    } catch (error) {
      console.warn(
        `[finishCloudJob] Failed to clean sandbox OIDC targets for job ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (status !== CloudTaskStatus.Idle) {
    try {
      await revokeCloudJobScopedGitLabTokens(job);
    } catch (error) {
      console.warn(
        `[finishCloudJob] Failed to revoke GitLab scoped tokens for job ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (payloadKind === TaskPayloadKind.SnapshotResume) {
    try {
      await ensureSnapshotResumeGitHubFollowUpFallback({ resumeJobId: job.id });
    } catch (err) {
      console.error(
        `[finishCloudJob] Failed to enqueue deferred SnapshotResume GitHub fallback for job ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // GitHub PR review cleanup: reaction, check run, and stale summary comment.
  // PR linkage and the GitHub-native identifiers live on task_pull_requests.
  if (task.workflow === 'pr_review') {
    await cleanupGithubPrReviewArtifacts(job, status);
  }

  // Slack failure notification: post a thread reply when the job failed and
  // was triggered from Slack (the task carries a Slack thread binding).
  if (status === CloudTaskStatus.Failed && task.slackThreadTs) {
    try {
      await sendSlackFailureNotification(job, sanitizedError);
    } catch (err) {
      console.error(
        `[finishCloudJob] Failed to send Slack failure notification for job ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Teams failure notification: post a thread reply when the job failed and
  // was triggered from Teams (payload carries Teams communication metadata).
  if (
    status === CloudTaskStatus.Failed &&
    !task.slackThreadTs &&
    getCommunicationProviderFromTaskPayload(job.payload) === 'teams'
  ) {
    try {
      await sendTeamsFailureNotification(job);
    } catch (err) {
      console.error(
        `[finishCloudJob] Failed to send Teams failure notification for job ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const linkedEnvironmentDefinitionId =
    status === CloudTaskStatus.Idle && job.taskPhase === 'waiting_for_prompt'
      ? await resolveSetupCompletionEnvironmentDefinitionId(job)
      : null;

  if (
    (status === CloudTaskStatus.Completed ||
      linkedEnvironmentDefinitionId !== null) &&
    (payloadKind === TaskPayloadKind.SlackAppMention ||
      payloadKind === TaskPayloadKind.SnapshotResume)
  ) {
    try {
      await sendSlackSetupCompletionNotification(job);
    } catch (err) {
      console.error(
        `[finishCloudJob] Failed to send Slack setup completion notification for job ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (status === CloudTaskStatus.Completed) {
    try {
      await maybeSendSlackQuestionChannelInvite(job);
    } catch (err) {
      console.error(
        `[finishCloudJob] Failed to send Slack question-channel invite for job ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Linear failure notification: emit an error activity when the job failed
  // and was triggered from Linear (the task carries a Linear session binding).
  if (status === CloudTaskStatus.Failed && task.linearSessionId) {
    try {
      await sendLinearFailureNotification(job, sanitizedError);
    } catch (err) {
      console.error(
        `[finishCloudJob] Failed to send Linear failure notification for job ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // GitHub PR conflict resolution comment
  if (
    task.workflow === 'pr_conflict_resolve' &&
    (status === CloudTaskStatus.Completed || status === CloudTaskStatus.Failed)
  ) {
    try {
      await postConflictResolutionComment(job, status, sanitizedError);
    } catch (err) {
      console.error(
        `[finishCloudJob] Failed to post conflict resolution comment for job ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
};

/**
 * Returns the task's PR rows ordered by detection time. For PR-triggered
 * workflows the first row is the one inserted at enqueue.
 */
async function findTaskPullRequests(
  taskId: string,
): Promise<TaskPullRequest[]> {
  return db.query.taskPullRequests.findMany({
    where: eq(taskPullRequests.taskId, taskId),
    orderBy: [
      asc(taskPullRequests.detectedAt),
      asc(taskPullRequests.createdAt),
    ],
  });
}

async function cleanupGithubPrReviewArtifacts(
  job: FinishedRun,
  status:
    | CloudTaskStatus.Completed
    | CloudTaskStatus.Failed
    | CloudTaskStatus.Canceled
    | CloudTaskStatus.Idle,
): Promise<void> {
  let prRows: TaskPullRequest[];

  try {
    prRows = await findTaskPullRequests(job.taskId);
  } catch (error) {
    console.error(
      `[finishCloudJob] Failed to load task_pull_requests for task ${job.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  for (const prRow of prRows) {
    if (
      prRow.sourceControlProvider !== 'github' ||
      !prRow.repository ||
      !prRow.prNumber
    ) {
      continue;
    }

    const [owner, repo] = prRow.repository.split('/');

    if (!owner || !repo) {
      continue;
    }

    if (prRow.githubReactionId) {
      try {
        const token = await createCloudJobGitHubToken(job);

        await deleteReaction(token, {
          reaction_id: prRow.githubReactionId,
          owner,
          repo,
          issue_number: prRow.prNumber,
        });

        await db
          .update(taskPullRequests)
          .set({ githubReactionId: null, updatedAt: new Date() })
          .where(eq(taskPullRequests.id, prRow.id));
      } catch (error) {
        console.error(
          `[finishCloudJob] Failed to delete reaction for job ${job.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (prRow.githubCheckRunId) {
      try {
        const token = await createCloudJobGitHubToken(job);

        await updateCheckRun(token, {
          owner,
          repo,
          check_run_id: prRow.githubCheckRunId,
          status: 'completed',
          conclusion: 'success',
        });
      } catch (error) {
        console.error(
          `[finishCloudJob] Failed to complete check run for job ${job.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // GitHub PR review summary comment finalization (safety net).
    // The review-code skill is responsible for patching the summary comment's
    // in-progress status to a terminal result, but when it doesn't (the job
    // failed before the agent ran, the agent skipped the update, or posted the
    // result as a separate comment) the starting line stays forever. This
    // ensures the comment reflects the terminal job outcome without clobbering
    // a real agent completion (it only patches comments still showing an
    // in-progress status line).
    if (status !== CloudTaskStatus.Idle) {
      try {
        const token = await createCloudJobGitHubToken(job);
        const outcome =
          status === CloudTaskStatus.Completed
            ? 'completed'
            : status === CloudTaskStatus.Failed
              ? 'failed'
              : 'canceled';
        const terminalStatus = buildTerminalReviewStatus({
          outcome,
          taskUrl: getTaskUrl({
            taskId: job.taskId,
            utm: {
              source: 'github-comment',
              medium: 'link',
              campaign: 'github.pr.review',
            },
          }),
        });

        const finalized = await finalizeGithubPrReviewComment({
          gitHubToken: token,
          owner,
          repo,
          prNumber: prRow.prNumber,
          commentId: prRow.githubReviewCommentId,
          terminalStatus,
        });

        if (finalized) {
          console.log(
            `[finishCloudJob] Finalized stale PR review summary comment for job ${job.id} on ${prRow.repository}#${prRow.prNumber}`,
          );
        }
      } catch (error) {
        console.error(
          `[finishCloudJob] Failed to finalize PR review summary comment for job ${job.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function getRuntimeTaskId(job: CloudJob): string | null {
  if (
    !job.result ||
    typeof job.result !== 'object' ||
    Array.isArray(job.result)
  ) {
    return null;
  }

  const result = job.result as Record<string, unknown>;

  return typeof result.runtimeTaskId === 'string' ? result.runtimeTaskId : null;
}

function hasReachedTaskRuntime(job: CloudJob): boolean {
  return (
    getRuntimeTaskId(job) !== null ||
    job.runtimeTaskStartedAt != null ||
    job.firstAssistantOutputAt != null
  );
}

/**
 * Post a failure notice back into the originating Teams conversation when a
 * Teams-launched job fails. Mirrors the Slack failure notification path using
 * the provider-neutral communication metadata on the task payload.
 */
async function sendTeamsFailureNotification(job: FinishedRun): Promise<void> {
  const provider =
    await createTeamsCommunicationProviderFromRuntimeCredentials();

  if (!provider) {
    console.warn(
      `[finishCloudJob] Teams bot credentials are not configured, skipping Teams failure notification for job ${job.id}`,
    );
    return;
  }

  const channelId = getCommunicationChannelFromTaskPayload(job.payload);
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(job.payload);

  if (!channelId || !serviceUrl) {
    console.warn(
      `[finishCloudJob] Missing Teams conversation metadata for job ${job.id}, skipping Teams failure notification`,
    );
    return;
  }

  const threadId = getCommunicationThreadIdFromTaskPayload(job.payload);
  const messageId = getCommunicationMessageIdFromTaskPayload(job.payload);
  const replyToMessageId = threadId ?? messageId;
  const failureText = hasReachedTaskRuntime(job)
    ? TASK_RUNTIME_FAILURE_TEXT
    : TASK_STARTUP_FAILURE_TEXT;
  const taskUrl = getTaskUrl({
    taskId: job.taskId,
    utm: { campaign: job.payloadKind, source: 'teams' },
  });
  const text = taskUrl
    ? `${failureText}\n\n${formatMarkdownLink('Open the task', taskUrl)}`
    : failureText;

  await provider.postMessage({
    channelId,
    serviceUrl,
    ...(threadId ? { threadId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    text,
    textFormat: 'markdown',
  });

  console.log(
    `[finishCloudJob] Sent Teams failure notification for job ${job.id}`,
  );
}

/**
 * Handle Slack cleanup and any required failure handoff when a job fails.
 * Resolves the active Slack installation for the org, extracts the channel
 * from the task's channel bindings, removes stale controls from the started
 * message, then posts either setup onboarding guidance or a retryable generic
 * failure message back into the Slack thread.
 */
async function sendSlackFailureNotification(
  job: FinishedRun,
  _error?: string,
): Promise<void> {
  const task = job.task;
  const runtimeAlreadyStarted = hasReachedTaskRuntime(job);
  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: and(eq(slackInstallations.isActive, true)),
  });

  if (!slackInstallation) {
    console.warn(
      `[finishCloudJob] No active Slack installation, skipping Slack notification`,
    );
    return;
  }

  const { channel, threadTs, route } = await resolveSlackJobRouting(job);

  if (!channel) {
    console.warn(
      `[finishCloudJob] No channel found for job ${job.id}, skipping Slack notification`,
    );
    return;
  }

  const isSetupOnboarding = route.kind === 'setup-onboarding';

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const taskUrl = isSetupOnboarding
    ? buildSlackWebPathUrl(route.webPath, 'setup.onboarding.failed')
    : getTaskUrl({
        taskId: job.taskId,
        utm: { campaign: job.payloadKind, source: 'slack' },
      });

  // Remove the cancel button from the started message.
  const slackStartedMessageTs = await getSlackStartedMessageTs(job.id);
  if (slackStartedMessageTs && task.slackThreadTs) {
    await slack.removeCancelButton({
      channel,
      messageTs: slackStartedMessageTs,
      threadTs: task.slackThreadTs,
    });
  }

  if (!isSetupOnboarding) {
    const threadReplyTs = threadTs ?? task.slackThreadTs!;
    const retryableFailureText = runtimeAlreadyStarted
      ? SLACK_RUNTIME_FAILURE_TEXT
      : SLACK_STARTUP_FAILURE_TEXT;
    const restartFailureText =
      "I ran into a hiccup and couldn't get started. Please send a fresh Slack message and I'll give it another shot.";

    const failureMessage =
      job.payloadKind === TaskPayloadKind.SlackAppMention
        ? buildTaskFailedMessage({
            cloudJobId: job.id,
            messageText: retryableFailureText,
          })
        : {
            text: restartFailureText,
          };

    const shouldUpdateStartedMessage =
      slackStartedMessageTs != null && !runtimeAlreadyStarted;

    const updatedExistingStatus =
      shouldUpdateStartedMessage &&
      (await slack.updateMessage({
        channel,
        ts: slackStartedMessageTs,
        message: failureMessage,
      }));

    if (!updatedExistingStatus) {
      await slack.postMessage({
        channel,
        thread_ts: threadReplyTs,
        ...failureMessage,
      });
    }

    console.log(
      `[finishCloudJob] Sent Slack failure notification for job ${job.id}`,
    );
    return;
  }

  const messageTs = await slack.postMessage({
    channel,
    thread_ts: threadTs ?? task.slackThreadTs!,
    text: `I ran into an issue when setting things up. <${taskUrl}|Continue on the web app> to fix it.`,
    unfurl_links: false,
    unfurl_media: false,
  });

  const failureSubject = job.actingUserId
    ? await findSlackConversationSubjectByUserId({
        userId: job.actingUserId,
        slackTeamId: slackInstallation.teamId,
      })
    : null;

  if (failureSubject && messageTs) {
    await recordSlackConversationMessageBestEffort({
      logContext: 'finishCloudJob.setupFailure',
      ...failureSubject,
      slackChannelId: channel,
      conversationKind: 'thread',
      threadTs: threadTs ?? task.slackThreadTs!,
      messageTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: 'setup_failure',
      text: `I ran into an issue when setting things up. ${taskUrl}`,
      taskId: job.taskId,
      cloudJobId: job.id,
    });
  }

  console.log(
    `[finishCloudJob] Sent Slack failure notification for job ${job.id}`,
  );
}

function formatSlackChannelSuggestionList(
  channels: Array<{ id: string }>,
): string {
  const mentions = channels.map((channel) => `<#${channel.id}>`);

  if (mentions.length === 0) {
    return '';
  }

  if (mentions.length === 1) {
    return mentions[0]!;
  }

  if (mentions.length === 2) {
    return `${mentions[0]} or ${mentions[1]}`;
  }

  return `${mentions.slice(0, -1).join(', ')}, or ${mentions.at(-1)}`;
}

function buildSlackQuestionChannelInviteMessage(
  channels: Array<{ id: string }>,
): string {
  const settingsUrl = buildManagerSlackSettingsUrl();
  const lines = [
    "You've finished a couple of real tasks. The next useful step is a shared manager channel for Roomote asks and summaries.",
    'Create or reuse `#roomote-managers`, invite me there, then set it as your Manager Channel in Automations.',
  ];

  const formattedChannelList = formatSlackChannelSuggestionList(channels);

  if (formattedChannelList) {
    lines.push(`Perhaps ${formattedChannelList}?`);
  }

  lines.push(`<${settingsUrl}|Open automations settings>.`);

  return lines.join('\n');
}

function buildSlackQuestionChannelInviteClaimKey(params: {
  slackInstallationId: string;
  taskId: string;
}): string {
  return `slack:question-channel-invite:${params.slackInstallationId}:${params.taskId}`;
}

function buildSlackSetupCompletionClaimKey(params: {
  slackInstallationId: string;
  taskId: string;
}): string {
  return `slack:setup-completion:${params.slackInstallationId}:${params.taskId}`;
}

const SLACK_ONBOARDING_STAGE = {
  AwaitingTaskMilestone: 'awaiting_task_milestone',
  Done: 'done',
} as const;

async function maybeSendSlackQuestionChannelInvite(
  job: FinishedRun,
): Promise<void> {
  const task = job.task;
  const invitedUserId = job.actingUserId;

  if (
    !invitedUserId ||
    !task.requestedWorkKind ||
    task.requestedWorkKind === 'unknown'
  ) {
    return;
  }

  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      slackOnboardingStage: true,
    },
  });

  if (
    deployment?.slackOnboardingStage !==
    SLACK_ONBOARDING_STAGE.AwaitingTaskMilestone
  ) {
    return;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(slackInstallations.isActive, true),
      eq(slackInstallations.installedByUserId, invitedUserId),
    ),
    columns: {
      id: true,
      teamId: true,
      botAccessToken: true,
      updatedAt: true,
    },
    with: {
      joinedChannels: {
        columns: {
          channelId: true,
        },
      },
    },
  });

  if (!slackInstallation || slackInstallation.joinedChannels.length > 0) {
    return;
  }

  const slackUserMapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.userId, invitedUserId),
      eq(slackUserMappings.slackTeamId, slackInstallation.teamId),
    ),
    columns: {
      slackUserId: true,
      updatedAt: true,
    },
  });

  if (!slackUserMapping) {
    return;
  }

  const inviteEligibilityStartAt =
    slackUserMapping.updatedAt > slackInstallation.updatedAt
      ? slackUserMapping.updatedAt
      : slackInstallation.updatedAt;

  // Completed tasks initiated by this user with a known work kind. State and
  // requestedWorkKind live on tasks; completion time is the terminal run's
  // completedAt.
  const completedTaskRows = await db
    .select({
      taskId: tasks.id,
      requestedWorkKind: tasks.requestedWorkKind,
      completedAt: taskRuns.completedAt,
    })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.initiatorUserId, invitedUserId),
        eq(tasks.state, 'completed'),
        eq(taskRuns.status, CloudTaskStatus.Completed),
        isNotNull(taskRuns.completedAt),
      ),
    );

  const completedEligibleTaskCount = new Set(
    completedTaskRows
      .filter(
        (row) =>
          row.requestedWorkKind &&
          row.requestedWorkKind !== 'unknown' &&
          row.completedAt &&
          row.completedAt >= inviteEligibilityStartAt,
      )
      .map((row) => row.taskId),
  ).size;

  if (completedEligibleTaskCount !== 2) {
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const dmChannelId = await slack.openConversation(
    slackUserMapping.slackUserId,
  );

  if (!dmChannelId) {
    return;
  }

  const publicChannels = await slack.listPublicChannels();
  const suggestedChannels = await suggestSlackQuestionChannels({
    userId: invitedUserId,
    taskId: job.taskId,
    channels: publicChannels,
  });
  const redis = getRedis();
  const claimKey = buildSlackQuestionChannelInviteClaimKey({
    slackInstallationId: slackInstallation.id,
    taskId: job.taskId,
  });
  const claim = await redis.set(claimKey, '1', 'EX', 30 * 24 * 60 * 60, 'NX');

  if (claim !== 'OK') {
    return;
  }

  const messageTs = await slack.postMessage({
    channel: dmChannelId,
    text: buildSlackQuestionChannelInviteMessage(suggestedChannels),
  });

  if (!messageTs) {
    await redis.del(claimKey);
    console.warn(
      `[finishCloudJob] Failed to send Slack question-channel invite DM for job ${job.id}`,
    );
    return;
  }

  await recordSlackConversationMessageBestEffort({
    logContext: 'finishCloudJob.questionChannelInvite',
    subjectUserId: invitedUserId,
    slackTeamId: slackInstallation.teamId,
    subjectSlackUserId: slackUserMapping.slackUserId,
    slackChannelId: dmChannelId,
    conversationKind: 'dm',
    messageTs,
    direction: 'outbound',
    authorKind: 'roomote',
    source: 'question_channel_invite',
    text: buildSlackQuestionChannelInviteMessage(suggestedChannels),
    taskId: job.taskId,
    cloudJobId: job.id,
  });

  await db
    .update(deploymentSettings)
    .set({
      slackOnboardingStage: SLACK_ONBOARDING_STAGE.Done,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
        eq(
          deploymentSettings.slackOnboardingStage,
          SLACK_ONBOARDING_STAGE.AwaitingTaskMilestone,
        ),
      ),
    );
}

async function sendSlackSetupCompletionNotification(job: FinishedRun) {
  const { channel, threadTs, route } = await resolveSlackJobRouting(job);

  if (route.kind !== 'setup-onboarding' || !threadTs) {
    return;
  }

  if (!channel) {
    console.warn(
      `[finishCloudJob] No channel found for setup completion job ${job.id}, skipping Slack notification`,
    );
    return;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: and(eq(slackInstallations.isActive, true)),
  });

  if (!slackInstallation) {
    console.warn(
      `[finishCloudJob] No active Slack installation, skipping setup completion Slack notification`,
    );
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const setupUrl = buildSlackWebPathUrl(
    route.webPath,
    'setup.onboarding.completed',
  );
  const projectName = getSlackProjectNameFromPayload(job.payload);
  const slackStartedMessageTs = await getSlackStartedMessageTs(job.id);

  if (slackStartedMessageTs) {
    await slack.removeCancelButton({
      channel,
      messageTs: slackStartedMessageTs,
      threadTs,
    });
  }

  const redis = getRedis();
  // All resume runs share the task, so the task id is the natural claim
  // scope (previously the root run of the sourceCloudJobId chain).
  const claimKey = buildSlackSetupCompletionClaimKey({
    slackInstallationId: slackInstallation.id,
    taskId: job.taskId,
  });
  const claim = await redis.set(claimKey, '1', 'EX', 30 * 24 * 60 * 60, 'NX');

  if (claim !== 'OK') {
    return;
  }

  const completionMessage = projectName
    ? `Setup for the ${projectName} project is done. Continue on the web: <${setupUrl}|Open setup>.`
    : `Setup is done. Continue on the web: <${setupUrl}|Open setup>.`;

  let messageTs: string | undefined;

  try {
    messageTs = await slack.postMessage({
      channel,
      thread_ts: threadTs,
      text: completionMessage,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    await redis.del(claimKey);
    throw error;
  }

  if (!messageTs) {
    await redis.del(claimKey);
    console.warn(
      `[finishCloudJob] Failed to send setup completion Slack notification for job ${job.id}`,
    );
    return;
  }

  const completionSubject = job.actingUserId
    ? await findSlackConversationSubjectByUserId({
        userId: job.actingUserId,
        slackTeamId: slackInstallation.teamId,
      })
    : null;

  if (completionSubject && messageTs) {
    await recordSlackConversationMessageBestEffort({
      logContext: 'finishCloudJob.setupCompletion',
      ...completionSubject,
      slackChannelId: channel,
      conversationKind: 'thread',
      threadTs,
      messageTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: 'setup_completion',
      text: projectName
        ? `Setup for the ${projectName} project is done. Continue on the web: ${setupUrl}`
        : `Setup is done. Continue on the web: ${setupUrl}`,
      taskId: job.taskId,
      cloudJobId: job.id,
    });
  }
}

/**
 * Setup-onboarding resumes carry the environment definition id somewhere in
 * the payloads of the task's run chain. Instead of walking sourceRunId links,
 * scan the sibling runs of the task from newest to oldest.
 */
async function resolveSetupCompletionEnvironmentDefinitionId(
  job: Pick<FinishedRun, 'id' | 'payload' | 'taskId'>,
): Promise<string | null> {
  const environmentDefinitionId = getEnvironmentDefinitionIdFromPayload(
    job.payload,
  );

  if (environmentDefinitionId) {
    return environmentDefinitionId;
  }

  const siblingRuns = await db.query.taskRuns.findMany({
    columns: {
      id: true,
      payload: true,
    },
    where: eq(taskRuns.taskId, job.taskId),
    orderBy: [asc(taskRuns.id)],
  });

  for (const run of siblingRuns) {
    if (run.id === job.id) {
      continue;
    }

    const fromSibling = getEnvironmentDefinitionIdFromPayload(run.payload);

    if (fromSibling) {
      return fromSibling;
    }
  }

  return null;
}

function getSlackProjectNameFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const repo = (payload as { repo?: unknown }).repo;

  if (typeof repo !== 'string') {
    return null;
  }

  const trimmedRepo = repo.trim();

  if (!trimmedRepo || trimmedRepo === ALL_REPOSITORIES) {
    return null;
  }

  const repoSegments = trimmedRepo.split('/');
  const projectName = repoSegments[repoSegments.length - 1]?.trim();

  return projectName && projectName.length > 0 ? projectName : null;
}

function buildSlackWebPathUrl(webPath: string, campaign: string): string {
  const url = new URL(
    webPath,
    process.env.ROOMOTE_APP_URL || DEFAULT_LOCAL_ROOMOTE_APP_URL,
  );

  url.searchParams.set('utm_source', 'slack');
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', campaign);

  return url.toString();
}

/**
 * Emit a Linear error activity when a job fails.
 * Resolves the active Linear installation for the org, obtains a valid
 * access token, and emits an error event to the session.
 */
async function sendLinearFailureNotification(
  job: FinishedRun,
  error?: string,
): Promise<void> {
  const connection = await findLinearDeploymentMcpConnection();
  if (!connection) {
    console.warn(
      `[finishCloudJob] No active Linear MCP connection, skipping Linear notification`,
    );
    return;
  }

  const accessToken = await getValidAccessToken(
    connection.id,
    'https://mcp.linear.app/mcp',
  );

  if (!accessToken) {
    console.warn(
      `[finishCloudJob] Could not obtain valid Linear access token, skipping Linear notification`,
    );
    return;
  }

  const client = new LinearClient(accessToken);
  const errorMessage = error ?? 'Task failed with an unknown error.';

  await client.emitError(job.task.linearSessionId!, errorMessage);

  console.log(
    `[finishCloudJob] Sent Linear failure notification for job ${job.id}`,
  );
}

async function postConflictResolutionComment(
  job: FinishedRun,
  status: CloudTaskStatus.Completed | CloudTaskStatus.Failed,
  error?: string,
): Promise<void> {
  const prRows = await findTaskPullRequests(job.taskId);
  const prRow = prRows.find(
    (row) =>
      row.sourceControlProvider === 'github' && row.repository && row.prNumber,
  );

  if (!prRow?.repository || !prRow.prNumber) {
    console.warn(
      `[finishCloudJob] Skipping conflict resolution comment for job ${job.id}: no linked GitHub pull request row`,
    );
    return;
  }

  console.log(
    `[finishCloudJob] postConflictResolutionComment called for job ${job.id} (status=${status}, repo=${prRow.repository}, pr=${prRow.prNumber})`,
  );

  const token = await createCloudJobGitHubToken(job);
  const [owner, repo] = prRow.repository.split('/');

  if (!owner || !repo) {
    console.warn(
      `[finishCloudJob] Skipping conflict resolution comment: malformed repository (${prRow.repository})`,
    );

    return;
  }

  const persistedSummary = readConflictResolutionSummary(job.result);

  const fallbackCompletionText = persistedSummary
    ? null
    : await getPersistedConflictResolutionCompletion(job.id);

  const parsedSummary =
    persistedSummary ??
    (fallbackCompletionText
      ? parseConflictResolutionSummary(fallbackCompletionText)
      : null);

  if (status === CloudTaskStatus.Completed) {
    await createIssueComment(token, {
      owner,
      repo,
      issue_number: prRow.prNumber,
      body: parsedSummary
        ? formatConflictResolutionSuccessComment(parsedSummary)
        : 'Resolved merge conflicts on this PR.',
    });
  } else {
    await createIssueComment(token, {
      owner,
      repo,
      issue_number: prRow.prNumber,
      body: formatConflictResolutionFailureComment(
        error || 'The automated resolution encountered an error.',
      ),
    });
  }

  console.log(
    `[finishCloudJob] Posted conflict resolution ${status} comment for job ${job.id} on ${prRow.repository}#${prRow.prNumber}`,
  );
}

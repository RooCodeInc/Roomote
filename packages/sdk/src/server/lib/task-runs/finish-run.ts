import {
  TaskPayloadKind,
  RunStatus,
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getEnvironmentDefinitionIdFromPayload,
  parseConflictResolutionSummary,
  stripRunErrorMarkers,
} from '@roomote/types';
import {
  formatMarkdownLink,
  TASK_RUNTIME_FAILURE_TEXT,
  TASK_STARTUP_FAILURE_TEXT,
} from '@roomote/communication/chat-messages';
import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '../teams-communication';
import {
  type TaskRun,
  type Task,
  type TaskPullRequest,
  db,
  taskRuns,
  taskPullRequests,
  deploymentSettings,
  markTaskStartParallelCountEndedAt,
  recordTaskRunLifecycleEvent,
  slackInstallations,
  slackUserMappings,
  syncTaskStateFromRuns,
  asc,
  eq,
  and,
  isNotNull,
  tasks,
  resolveDiscordRuntimeCredentials,
} from '@roomote/db/server';
import {
  buildTerminalReviewStatus,
  finalizeGithubPrReviewComment,
  getTaskUrl,
  releaseTaskRun,
  suggestSlackQuestionChannels,
} from '@roomote/cloud-agents/server';
import { captureEvent } from '@roomote/telemetry/server';
import {
  createTaskRunGitHubToken,
  createIssueComment,
  deleteReaction,
  updateCheckRun,
} from '@roomote/github';
import { revokeTaskRunScopedGitLabTokens } from '@roomote/gitlab';
import {
  formatConflictResolutionFailureComment,
  formatConflictResolutionSuccessComment,
  getPersistedConflictResolutionCompletion,
  readConflictResolutionSummary,
} from './conflict-resolution-comments';
import { cleanupSandboxOidcTargetsForTaskRun } from '../sandbox-oidc';
import { notifySourceRunOnSettle } from './notify-source-run-on-settle';
import { refreshTaskTitleOnCompletion } from './record-task-message-envelope';
import { getRedis } from '@roomote/redis';
import { resolveSlackTaskRunRouting } from './slack-task-run-routing';
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

const DEFAULT_LOCAL_R_APP_URL = 'http://localhost:13000';
const DEFAULT_DEPLOYMENT_ID = 'default';

/**
 * TaskRun + its owning task, as loaded by the terminal path. Side-effect helpers
 * read conversation cargo (channel bindings, requestedWorkKind, initiator)
 * from `task` and attempt-scoped state from the run row.
 */
type FinishedRun = TaskRun & { task: Task };

export const finishRun = async ({
  id,
  status,
  error,
}: {
  id: number;
  status:
    | RunStatus.Completed
    | RunStatus.Failed
    | RunStatus.Canceled
    | RunStatus.Idle;
  error?: string;
}) => {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, id),
    with: { task: true },
  });

  if (!run) {
    return;
  }

  const task = run.task;

  // Persist/report consistency for user-stopped runs: a stop request persisted
  // on the row (cancelRequestedAt) means a Failed finalization is the fallout
  // of a deliberate user stop — e.g. the sandbox died before the cancel
  // completed. Normalize the status up front so EVERYTHING downstream agrees:
  // the persisted run status, the derived tasks.state (the canonical read for
  // task history, analytics, and unfurls), the lifecycle event, notifications,
  // and GitHub-facing outcomes all see Canceled. The sanitized error is still
  // written to the run's `error` column below for debugging.
  if (status === RunStatus.Failed && run.cancelRequestedAt != null) {
    console.log(
      `[finishRun] Persisting the failed finalization of run ${id} as canceled: a stop was requested at ${run.cancelRequestedAt.toISOString()}`,
    );
    status = RunStatus.Canceled;
  }

  try {
    await releaseTaskRun(run);
  } catch (error) {
    console.error(
      `[finishRun] Failed to release lock for run ${id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const { payloadKind } = run;
  const sanitizedError = stripRunErrorMarkers(error);

  const now = new Date();
  const existingResult =
    run.result && typeof run.result === 'object' && !Array.isArray(run.result)
      ? (run.result as Record<string, unknown>)
      : {};
  const runtimeTaskId =
    typeof existingResult.runtimeTaskId === 'string'
      ? existingResult.runtimeTaskId
      : null;
  const lifecycleEvent =
    status === RunStatus.Completed
      ? {
          eventType: 'completed' as const,
          message: 'Task run finished successfully.',
        }
      : status === RunStatus.Failed
        ? {
            eventType: 'failed' as const,
            message: 'Task run finished with a failure.',
          }
        : status === RunStatus.Canceled
          ? {
              eventType: 'decision' as const,
              message: 'Task run was canceled.',
            }
          : {
              eventType: 'decision' as const,
              message:
                'Task run transitioned to idle while the machine remained alive.',
            };

  await db.transaction(async (tx) => {
    await tx
      .update(taskRuns)
      .set({
        status,
        taskPhase: status === RunStatus.Idle ? run.taskPhase : null,
        sleepAt: status === RunStatus.Idle ? run.sleepAt : null,
        error: sanitizedError,
        canceledAt: status === RunStatus.Canceled ? now : run.canceledAt,
        completedAt: status === RunStatus.Canceled ? null : now,
      })
      .where(eq(taskRuns.id, id));

    // Derive the durable task state from all of the task's runs via the shared
    // @roomote/db helper. This is one of several writers (cancel/dequeue/sleep/
    // snapshot paths also sync); routing them all through the same derivation
    // keeps siblings honest — an idle sibling keeps the task active, and a
    // failed-bootstrap resume can't clobber an already-completed task. The run
    // status was just written above, so it is visible to the derivation.
    await syncTaskStateFromRuns(tx, run.taskId);

    await markTaskStartParallelCountEndedAt(tx, {
      runId: id,
      endedAt: now,
    });

    await recordTaskRunLifecycleEvent(tx, {
      runId: run.id,
      taskId: run.taskId,
      eventType: lifecycleEvent.eventType,
      message: lifecycleEvent.message,
      details: {
        stage: 'finish_task_run',
        status,
        vendor: run.vendor ?? null,
        machineId: run.machineId ?? null,
        sourceSnapshotId: run.sourceSnapshotId ?? null,
        workerReleaseTag: run.workerReleaseTag ?? null,
        workerVersion: run.workerVersion ?? null,
        workerCommit: run.workerCommit ?? null,
        runtimeTaskId,
        previousTaskPhase: run.taskPhase ?? null,
        previousSleepAt: run.sleepAt?.toISOString() ?? null,
        previousSleepRequestedAt: run.sleepRequestedAt?.toISOString() ?? null,
        previousSnapshotRequestedAt:
          run.snapshotRequestedAt?.toISOString() ?? null,
        previousSnapshotCreatedAt: run.snapshotCreatedAt?.toISOString() ?? null,
        previousWorkerHeartbeatAt: run.workerHeartbeatAt?.toISOString() ?? null,
        sleepAt: status === RunStatus.Idle ? run.sleepAt?.toISOString() : null,
        taskPhase: status === RunStatus.Idle ? run.taskPhase : null,
        error: sanitizedError ?? null,
      },
      createdAt: now,
    });
  });

  // Deterministic spawned-task feedback: when this run was launched by
  // another task's run with notify-on-settle requested, deliver the outcome
  // into that launching run's session (waking it if idle) so the parent
  // never has to poll for it. Never throws. `run` was read before the
  // transaction, so splice in the error that was just finalized.
  await notifySourceRunOnSettle(
    { ...run, error: sanitizedError ?? run.error },
    status,
    run.task.title,
  );

  // Anonymous analytics (no-op unless enabled): terminal task outcome with
  // non-identifying routing facts only.
  if (status === RunStatus.Completed) {
    void captureEvent('task_completed', {
      ...(run.actingUserId ? { userId: run.actingUserId } : {}),
      properties: {
        taskType: run.payloadKind,
        harness: run.harness ?? null,
        computeProvider: run.vendor ?? null,
      },
    });
  }

  if (status === RunStatus.Completed || status === RunStatus.Failed) {
    try {
      await refreshTaskTitleOnCompletion({
        taskId: run.taskId,
        runId: run.id,
      });
    } catch (error) {
      console.warn(
        `[finishRun] Failed to refresh final title for run ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (status !== RunStatus.Idle) {
    try {
      await cleanupSandboxOidcTargetsForTaskRun(id);
    } catch (error) {
      console.warn(
        `[finishRun] Failed to clean sandbox OIDC targets for run ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (status !== RunStatus.Idle) {
    try {
      await revokeTaskRunScopedGitLabTokens(run);
    } catch (error) {
      console.warn(
        `[finishRun] Failed to revoke GitLab scoped tokens for run ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (payloadKind === TaskPayloadKind.SnapshotResume) {
    try {
      await ensureSnapshotResumeGitHubFollowUpFallback({ resumeRunId: run.id });
    } catch (err) {
      console.error(
        `[finishRun] Failed to enqueue deferred SnapshotResume GitHub fallback for run ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // GitHub PR review cleanup: reaction, check run, and stale summary comment.
  // PR linkage and the GitHub-native identifiers live on task_pull_requests.
  if (task.workflow === 'pr_review') {
    await cleanupGithubPrReviewArtifacts(run, status);
  }

  // Slack failure notification: post a thread reply when the run failed and
  // was triggered from Slack (the task carries a Slack thread binding).
  if (status === RunStatus.Failed && task.slackThreadTs) {
    try {
      await sendSlackFailureNotification(run, sanitizedError);
    } catch (err) {
      console.error(
        `[finishRun] Failed to send Slack failure notification for run ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Teams failure notification: post a thread reply when the run failed and
  // was triggered from Teams (payload carries Teams communication metadata).
  if (
    status === RunStatus.Failed &&
    !task.slackThreadTs &&
    getCommunicationProviderFromTaskPayload(run.payload) === 'teams'
  ) {
    try {
      await sendTeamsFailureNotification(run);
    } catch (err) {
      console.error(
        `[finishRun] Failed to send Teams failure notification for run ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Discord failure notification: keep failures inside the originating task
  // thread/forum post using the provider-neutral payload coordinates.
  if (
    status === RunStatus.Failed &&
    !task.slackThreadTs &&
    getCommunicationProviderFromTaskPayload(run.payload) === 'discord'
  ) {
    try {
      await sendDiscordFailureNotification(run);
    } catch (err) {
      console.error(
        `[finishRun] Failed to send Discord failure notification for run ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const linkedEnvironmentDefinitionId =
    status === RunStatus.Idle && run.taskPhase === 'waiting_for_prompt'
      ? await resolveSetupCompletionEnvironmentDefinitionId(run)
      : null;

  if (
    (status === RunStatus.Completed ||
      linkedEnvironmentDefinitionId !== null) &&
    (payloadKind === TaskPayloadKind.SlackAppMention ||
      payloadKind === TaskPayloadKind.SnapshotResume)
  ) {
    try {
      await cleanupSlackSetupCompletion(run);
    } catch (err) {
      console.error(
        `[finishRun] Failed to clean up Slack setup completion UI for run ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (status === RunStatus.Completed) {
    try {
      await maybeSendSlackQuestionChannelInvite(run);
    } catch (err) {
      console.error(
        `[finishRun] Failed to send Slack question-channel invite for run ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Linear failure notification: emit an error activity when the run failed
  // and was triggered from Linear (the task carries a Linear session binding).
  if (status === RunStatus.Failed && task.linearSessionId) {
    try {
      await sendLinearFailureNotification(run, sanitizedError);
    } catch (err) {
      console.error(
        `[finishRun] Failed to send Linear failure notification for run ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // GitHub PR conflict resolution comment
  if (
    task.workflow === 'pr_conflict_resolve' &&
    (status === RunStatus.Completed || status === RunStatus.Failed)
  ) {
    try {
      await postConflictResolutionComment(run, status, sanitizedError);
    } catch (err) {
      console.error(
        `[finishRun] Failed to post conflict resolution comment for run ${id}: ${
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
  run: FinishedRun,
  status:
    | RunStatus.Completed
    | RunStatus.Failed
    | RunStatus.Canceled
    | RunStatus.Idle,
): Promise<void> {
  let prRows: TaskPullRequest[];

  try {
    prRows = await findTaskPullRequests(run.taskId);
  } catch (error) {
    console.error(
      `[finishRun] Failed to load task_pull_requests for task ${run.taskId}: ${
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
        const token = await createTaskRunGitHubToken(run);

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
          `[finishRun] Failed to delete reaction for run ${run.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (prRow.githubCheckRunId) {
      try {
        const token = await createTaskRunGitHubToken(run);

        await updateCheckRun(token, {
          owner,
          repo,
          check_run_id: prRow.githubCheckRunId,
          status: 'completed',
          conclusion: 'success',
        });
      } catch (error) {
        console.error(
          `[finishRun] Failed to complete check run for run ${run.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // GitHub PR review summary comment finalization (safety net).
    // The review-code skill is responsible for patching the summary comment's
    // in-progress status to a terminal result, but when it doesn't (the run
    // failed before the agent ran, the agent skipped the update, or posted the
    // result as a separate comment) the starting line stays forever. This
    // ensures the comment reflects the terminal run outcome without clobbering
    // a real agent completion (it only patches comments still showing an
    // in-progress status line).
    if (status !== RunStatus.Idle) {
      try {
        const token = await createTaskRunGitHubToken(run);
        // A user-stopped run arrives here already normalized to Canceled (see
        // finishRun), so the review outcome maps naturally.
        const outcome =
          status === RunStatus.Completed
            ? 'completed'
            : status === RunStatus.Failed
              ? 'failed'
              : 'canceled';
        const terminalStatus = buildTerminalReviewStatus({
          outcome,
          taskUrl: getTaskUrl({
            taskId: run.taskId,
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
            `[finishRun] Finalized stale PR review summary comment for run ${run.id} on ${prRow.repository}#${prRow.prNumber}`,
          );
        }
      } catch (error) {
        console.error(
          `[finishRun] Failed to finalize PR review summary comment for run ${run.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function getRuntimeTaskId(run: TaskRun): string | null {
  if (
    !run.result ||
    typeof run.result !== 'object' ||
    Array.isArray(run.result)
  ) {
    return null;
  }

  const result = run.result as Record<string, unknown>;

  return typeof result.runtimeTaskId === 'string' ? result.runtimeTaskId : null;
}

function hasReachedTaskRuntime(run: TaskRun): boolean {
  return (
    getRuntimeTaskId(run) !== null ||
    run.runtimeTaskStartedAt != null ||
    run.firstAssistantOutputAt != null
  );
}

/**
 * Post a failure notice back into the originating Teams conversation when a
 * Teams-launched run fails. Mirrors the Slack failure notification path using
 * the provider-neutral communication metadata on the task payload.
 */
async function sendTeamsFailureNotification(run: FinishedRun): Promise<void> {
  const provider =
    await createTeamsCommunicationProviderFromRuntimeCredentials();

  if (!provider) {
    console.warn(
      `[finishRun] Teams bot credentials are not configured, skipping Teams failure notification for run ${run.id}`,
    );
    return;
  }

  const channelId = getCommunicationChannelFromTaskPayload(run.payload);
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(run.payload);

  if (!channelId || !serviceUrl) {
    console.warn(
      `[finishRun] Missing Teams conversation metadata for run ${run.id}, skipping Teams failure notification`,
    );
    return;
  }

  const threadId = getCommunicationThreadIdFromTaskPayload(run.payload);
  const messageId = getCommunicationMessageIdFromTaskPayload(run.payload);
  const replyToMessageId = threadId ?? messageId;
  const failureText = hasReachedTaskRuntime(run)
    ? TASK_RUNTIME_FAILURE_TEXT
    : TASK_STARTUP_FAILURE_TEXT;
  const taskUrl = getTaskUrl({
    taskId: run.taskId,
    utm: { campaign: run.payloadKind, source: 'teams' },
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

  console.log(`[finishRun] Sent Teams failure notification for run ${run.id}`);
}

async function createDiscordCommunicationProviderFromRuntimeCredentials(): Promise<DiscordCommunicationProvider | null> {
  const { botToken, applicationId } = await resolveDiscordRuntimeCredentials();
  if (!botToken) {
    return null;
  }
  return new DiscordCommunicationProvider({
    botToken,
    ...(applicationId ? { applicationId } : {}),
  });
}

async function sendDiscordFailureNotification(run: FinishedRun): Promise<void> {
  const provider =
    await createDiscordCommunicationProviderFromRuntimeCredentials();
  if (!provider) {
    console.warn(
      `[finishRun] Discord bot credentials are not configured, skipping Discord failure notification for run ${run.id}`,
    );
    return;
  }

  const channelId = getCommunicationChannelFromTaskPayload(run.payload);
  if (!channelId) {
    console.warn(
      `[finishRun] Missing Discord channel metadata for run ${run.id}, skipping Discord failure notification`,
    );
    return;
  }

  const threadId = getCommunicationThreadIdFromTaskPayload(run.payload);
  const failureText = hasReachedTaskRuntime(run)
    ? TASK_RUNTIME_FAILURE_TEXT
    : TASK_STARTUP_FAILURE_TEXT;
  const taskUrl = getTaskUrl({
    taskId: run.taskId,
    utm: { campaign: run.payloadKind, source: 'discord' },
  });
  const text = taskUrl
    ? `${failureText}\n\n${formatMarkdownLink('Open the task', taskUrl)}`
    : failureText;

  await provider.postMessage({
    channelId,
    ...(threadId ? { threadId } : {}),
    text,
    textFormat: 'markdown',
  });

  console.log(
    `[finishRun] Sent Discord failure notification for run ${run.id}`,
  );
}

/**
 * Handle Slack cleanup and any required failure handoff when a run fails.
 * Resolves the active Slack installation for the org, extracts the channel
 * from the task's channel bindings, removes stale controls from the started
 * message, then posts either setup onboarding guidance or a retryable generic
 * failure message back into the Slack thread.
 */
async function sendSlackFailureNotification(
  run: FinishedRun,
  _error?: string,
): Promise<void> {
  const task = run.task;
  const runtimeAlreadyStarted = hasReachedTaskRuntime(run);
  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: and(eq(slackInstallations.isActive, true)),
  });

  if (!slackInstallation) {
    console.warn(
      `[finishRun] No active Slack installation, skipping Slack notification`,
    );
    return;
  }

  const { channel, threadTs, route } = await resolveSlackTaskRunRouting(run);

  if (!channel) {
    console.warn(
      `[finishRun] No channel found for run ${run.id}, skipping Slack notification`,
    );
    return;
  }

  const isSetupOnboarding = route.kind === 'setup-onboarding';

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const taskUrl = isSetupOnboarding
    ? buildSlackWebPathUrl(route.webPath, 'setup.onboarding.failed')
    : getTaskUrl({
        taskId: run.taskId,
        utm: { campaign: run.payloadKind, source: 'slack' },
      });

  // Remove the cancel button from the started message.
  const slackStartedMessageTs = await getSlackStartedMessageTs(run.id);
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
      run.payloadKind === TaskPayloadKind.SlackAppMention
        ? buildTaskFailedMessage({
            runId: run.id,
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
      `[finishRun] Sent Slack failure notification for run ${run.id}`,
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

  const failureSubject = run.actingUserId
    ? await findSlackConversationSubjectByUserId({
        userId: run.actingUserId,
        slackTeamId: slackInstallation.teamId,
      })
    : null;

  if (failureSubject && messageTs) {
    await recordSlackConversationMessageBestEffort({
      logContext: 'finishRun.setupFailure',
      ...failureSubject,
      slackChannelId: channel,
      conversationKind: 'thread',
      threadTs: threadTs ?? task.slackThreadTs!,
      messageTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: 'setup_failure',
      text: `I ran into an issue when setting things up. ${taskUrl}`,
      taskId: run.taskId,
      runId: run.id,
    });
  }

  console.log(`[finishRun] Sent Slack failure notification for run ${run.id}`);
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

const SLACK_ONBOARDING_STAGE = {
  AwaitingTaskMilestone: 'awaiting_task_milestone',
  Done: 'done',
} as const;

async function maybeSendSlackQuestionChannelInvite(
  run: FinishedRun,
): Promise<void> {
  const task = run.task;
  const invitedUserId = run.actingUserId;

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
        eq(taskRuns.status, RunStatus.Completed),
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
    taskId: run.taskId,
    channels: publicChannels,
  });
  const redis = getRedis();
  const claimKey = buildSlackQuestionChannelInviteClaimKey({
    slackInstallationId: slackInstallation.id,
    taskId: run.taskId,
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
      `[finishRun] Failed to send Slack question-channel invite DM for run ${run.id}`,
    );
    return;
  }

  await recordSlackConversationMessageBestEffort({
    logContext: 'finishRun.questionChannelInvite',
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
    taskId: run.taskId,
    runId: run.id,
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

async function cleanupSlackSetupCompletion(run: FinishedRun) {
  const { channel, threadTs, route } = await resolveSlackTaskRunRouting(run);

  if (route.kind !== 'setup-onboarding' || !threadTs || !channel) {
    return;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: and(eq(slackInstallations.isActive, true)),
  });

  if (!slackInstallation) {
    return;
  }

  const slackStartedMessageTs = await getSlackStartedMessageTs(run.id);

  if (!slackStartedMessageTs) {
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  await slack.removeCancelButton({
    channel,
    messageTs: slackStartedMessageTs,
    threadTs,
  });
}

/**
 * Setup-onboarding resumes carry the environment definition id somewhere in
 * the payloads of the task's run chain. Instead of walking sourceRunId links,
 * scan the sibling runs of the task from newest to oldest.
 */
async function resolveSetupCompletionEnvironmentDefinitionId(
  run: Pick<FinishedRun, 'id' | 'payload' | 'taskId'>,
): Promise<string | null> {
  const environmentDefinitionId = getEnvironmentDefinitionIdFromPayload(
    run.payload,
  );

  if (environmentDefinitionId) {
    return environmentDefinitionId;
  }

  const siblingRuns = await db.query.taskRuns.findMany({
    columns: {
      id: true,
      payload: true,
    },
    where: eq(taskRuns.taskId, run.taskId),
    orderBy: [asc(taskRuns.id)],
  });

  for (const siblingRun of siblingRuns) {
    if (siblingRun.id === run.id) {
      continue;
    }

    const fromSibling = getEnvironmentDefinitionIdFromPayload(
      siblingRun.payload,
    );

    if (fromSibling) {
      return fromSibling;
    }
  }

  return null;
}

function buildSlackWebPathUrl(webPath: string, campaign: string): string {
  return buildCommunicationWebPathUrl(webPath, 'slack', campaign);
}

function buildCommunicationWebPathUrl(
  webPath: string,
  source: 'slack' | 'discord',
  campaign: string,
): string {
  const url = new URL(
    webPath,
    process.env.R_APP_URL || DEFAULT_LOCAL_R_APP_URL,
  );

  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', campaign);

  return url.toString();
}

/**
 * Emit a Linear error activity when a run fails.
 * Resolves the active Linear installation for the org, obtains a valid
 * access token, and emits an error event to the session.
 */
async function sendLinearFailureNotification(
  run: FinishedRun,
  error?: string,
): Promise<void> {
  const connection = await findLinearDeploymentMcpConnection();
  if (!connection) {
    console.warn(
      `[finishRun] No active Linear MCP connection, skipping Linear notification`,
    );
    return;
  }

  const accessToken = await getValidAccessToken(
    connection.id,
    'https://mcp.linear.app/mcp',
  );

  if (!accessToken) {
    console.warn(
      `[finishRun] Could not obtain valid Linear access token, skipping Linear notification`,
    );
    return;
  }

  const client = new LinearClient(accessToken);
  const errorMessage = error ?? 'Task failed with an unknown error.';

  await client.emitError(run.task.linearSessionId!, errorMessage);

  console.log(`[finishRun] Sent Linear failure notification for run ${run.id}`);
}

async function postConflictResolutionComment(
  run: FinishedRun,
  status: RunStatus.Completed | RunStatus.Failed,
  error?: string,
): Promise<void> {
  const prRows = await findTaskPullRequests(run.taskId);
  const prRow = prRows.find(
    (row) =>
      row.sourceControlProvider === 'github' && row.repository && row.prNumber,
  );

  if (!prRow?.repository || !prRow.prNumber) {
    console.warn(
      `[finishRun] Skipping conflict resolution comment for run ${run.id}: no linked GitHub pull request row`,
    );
    return;
  }

  console.log(
    `[finishRun] postConflictResolutionComment called for run ${run.id} (status=${status}, repo=${prRow.repository}, pr=${prRow.prNumber})`,
  );

  const token = await createTaskRunGitHubToken(run);
  const [owner, repo] = prRow.repository.split('/');

  if (!owner || !repo) {
    console.warn(
      `[finishRun] Skipping conflict resolution comment: malformed repository (${prRow.repository})`,
    );

    return;
  }

  const persistedSummary = readConflictResolutionSummary(run.result);

  const fallbackCompletionText = persistedSummary
    ? null
    : await getPersistedConflictResolutionCompletion(run.id);

  const parsedSummary =
    persistedSummary ??
    (fallbackCompletionText
      ? parseConflictResolutionSummary(fallbackCompletionText)
      : null);

  if (status === RunStatus.Completed) {
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
    `[finishRun] Posted conflict resolution ${status} comment for run ${run.id} on ${prRow.repository}#${prRow.prNumber}`,
  );
}

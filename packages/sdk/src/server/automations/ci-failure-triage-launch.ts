import {
  buildCiFailureTriageDebounceKey,
  buildCiFailureTriageFingerprint,
  buildCiFailureTriagePrompt,
  buildRepositoryCoverage,
  enqueueTask,
  getTaskUrl,
  releaseCiFailureTriageInvestigation,
  tryClaimCiFailureTriageInvestigation,
  type FailedCiRun,
} from '@roomote/cloud-agents/server';
import {
  db,
  eq,
  getAutomationRuntime,
  recordAutomationRunOutcome,
  slackInstallations,
  upsertBackgroundAutomationSlackThread,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  buildAutomationRootFooterBlocks,
  refreshAutomationRootFooter,
  SlackNotifier,
} from '@roomote/slack';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  TaskPayloadKind,
  type SourceControlProvider,
  type TaskSurface,
} from '@roomote/types';

import { getCommunicationProviderAdapter } from '../lib/communication-providers';
import {
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';

const LOG_PREFIX = '[ci-failure-triage-launch]';

/** A broken default branch usually fails several workflows within minutes. */
export const CI_FAILURE_TRIAGE_DEBOUNCE_SECONDS = 15 * 60;

export type CiFailureTriageLaunchResult = {
  status: 'ok' | 'error';
  message: string;
  taskId?: string;
};

function taskSurfaceForProvider(provider: SourceControlProvider): TaskSurface {
  return provider;
}

function buildAnnouncementText(params: {
  repositoryFullName: string;
  defaultBranch: string;
  workflowName: string;
  runUrl: string;
  headSha: string;
}): string {
  return [
    `I noticed a CI failure on \`${params.defaultBranch}\` in ${params.repositoryFullName}.`,
    `The \`${params.workflowName}\` workflow failed in [run \`${params.headSha.slice(0, 7)}\`](${params.runUrl}), and I'm looking into it now. I'll report back here.`,
  ].join('\n');
}

async function resolveActiveSlackNotifier(): Promise<SlackNotifier | null> {
  const [installation] = await db
    .select({ botAccessToken: slackInstallations.botAccessToken })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  if (!installation?.botAccessToken) {
    return null;
  }

  return new SlackNotifier(installation.botAccessToken);
}

async function postSlackInvestigationAnnouncement(params: {
  destination: ResolvedAutomationDestination;
  text: string;
  automationLabel: string;
}): Promise<{ messageTs: string; slack: SlackNotifier } | null> {
  try {
    const slack = await resolveActiveSlackNotifier();
    if (!slack) {
      return null;
    }

    const blocks = [
      { type: 'markdown' as const, text: params.text },
      ...buildAutomationRootFooterBlocks({
        automationLabel: params.automationLabel,
      }),
    ];
    const messageTs = await slack.postMessage({
      channel: params.destination.channelId,
      text: params.text,
      unfurl_links: false,
      unfurl_media: false,
      blocks,
    });
    if (!messageTs) {
      return null;
    }
    return { messageTs, slack };
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to post investigation announcement: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function postNonSlackInvestigationAnnouncement(params: {
  destination: ResolvedAutomationDestination;
  text: string;
}): Promise<string | null> {
  try {
    const adapter = await getCommunicationProviderAdapter(
      params.destination.provider,
    );
    if (!adapter) {
      return null;
    }

    const serviceUrlFields = params.destination.serviceUrl
      ? { serviceUrl: params.destination.serviceUrl }
      : {};

    const root = await adapter.postMessage({
      channelId: params.destination.channelId,
      ...serviceUrlFields,
      text: params.text,
      textFormat: 'markdown',
    });
    return root.messageId ?? null;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to post investigation announcement (${params.destination.provider}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * Stamp the announcement identity onto the task payload so send_chat_reply /
 * finish-run can target the existing investigating opener.
 *
 * - Slack uses `thread_ts` / channel fields (handled separately).
 * - Teams reuse the activity id as both reply root and thread scope.
 * - Discord and Telegram keep the channel/chat id as the destination and only
 *   stamp `communicationMessageId` as the reply target — Discord's adapter
 *   treats `threadId` as a destination channel id, not a message id.
 */
function buildAnnouncementTaskPayloadFields(params: {
  destination: ResolvedAutomationDestination;
  announcementMessageId: string | null;
}): Record<string, string> {
  const base = buildDestinationTaskPayloadFields(params.destination);
  if (!params.announcementMessageId) {
    return base;
  }

  if (params.destination.provider === 'slack') {
    return {
      ...base,
      channel: params.destination.channelId,
      slackChannel: params.destination.channelId,
      thread_ts: params.announcementMessageId,
      slackThreadTs: params.announcementMessageId,
    };
  }

  return {
    ...base,
    communicationMessageId: params.announcementMessageId,
    ...(params.destination.provider === 'teams'
      ? { communicationThreadId: params.announcementMessageId }
      : {}),
  };
}

async function postAnnouncementThreadReply(params: {
  destination: ResolvedAutomationDestination;
  announcementMessageId: string;
  text: string;
  slack?: SlackNotifier | null;
}): Promise<void> {
  try {
    if (params.destination.provider === 'slack' && params.slack) {
      await params.slack.postMessage({
        channel: params.destination.channelId,
        thread_ts: params.announcementMessageId,
        text: params.text,
        unfurl_links: false,
        unfurl_media: false,
        blocks: [{ type: 'markdown', text: params.text }],
      });
      return;
    }

    const adapter = await getCommunicationProviderAdapter(
      params.destination.provider,
    );
    if (!adapter) {
      return;
    }
    const serviceUrlFields = params.destination.serviceUrl
      ? { serviceUrl: params.destination.serviceUrl }
      : {};

    // Keep channelId as the original destination. For Discord/Telegram, pass
    // the opener message only via replyToMessageId — never as threadId.
    // Teams also needs replyToMessageId (and may use threadId as activity root).
    await adapter.postMessage({
      channelId: params.destination.channelId,
      ...serviceUrlFields,
      replyToMessageId: params.announcementMessageId,
      ...(params.destination.provider === 'teams'
        ? { threadId: params.announcementMessageId }
        : {}),
      text: params.text,
      textFormat: 'markdown',
    });
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to post investigation-thread reply: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Shared CI failure triage launch path used by every SCM webhook adapter.
 * Expects a provider-neutral FailedCiRun whose Roomote repository row is
 * already resolved.
 */
export async function launchCiFailureTriageForFailedRun(
  run: FailedCiRun,
): Promise<CiFailureTriageLaunchResult> {
  if (run.headBranch !== run.defaultBranch) {
    return {
      status: 'ok',
      message: 'Ignoring workflow run outside the default branch',
    };
  }

  const runtime = await getAutomationRuntime('ci_failure_triage');
  if (!runtime.enabled || runtime.scheduleMode === 'off') {
    return { status: 'ok', message: 'CI failure triage is disabled' };
  }

  const connectedProviders = await listConnectedCommunicationProviders();
  const destination = await resolveAutomationRuntimeDestination({
    runtime,
    slackConnected: connectedProviders.includes('slack'),
  });
  if (!destination) {
    return { status: 'ok', message: 'Manager channel is not configured' };
  }

  const repositoryCoverage = await buildRepositoryCoverage([
    run.repositoryFullName,
  ]);
  const environmentId = repositoryCoverage[0]?.targetEnvironmentId;
  if (!environmentId) {
    return {
      status: 'ok',
      message: 'Repository has no configured environment for CI triage',
    };
  }

  const redis = getRedis();
  const debounceClaim = await redis.set(
    buildCiFailureTriageDebounceKey({
      provider: run.provider,
      repositoryId: run.repositoryId,
    }),
    run.runUrl,
    'EX',
    CI_FAILURE_TRIAGE_DEBOUNCE_SECONDS,
    'NX',
  );
  if (debounceClaim !== 'OK') {
    return {
      status: 'ok',
      message: 'CI failure triage already debounced for this repository',
    };
  }

  const fingerprint = buildCiFailureTriageFingerprint({
    repositoryFullName: run.repositoryFullName,
    workflowName: run.workflowOrPipelineName,
    headBranch: run.headBranch,
  });
  const investigationClaimed = await tryClaimCiFailureTriageInvestigation({
    provider: run.provider,
    repositoryFullName: run.repositoryFullName,
    fingerprint,
    marker: run.runUrl,
  });
  if (!investigationClaimed) {
    return {
      status: 'ok',
      message: 'CI failure triage fingerprint already has an active task',
    };
  }

  const automationLabel =
    getTriggerableBackgroundAutomationDescriptorByKey('ci_failure_triage')
      ?.label ?? 'CI Failure Triage';
  const announcementText = buildAnnouncementText({
    repositoryFullName: run.repositoryFullName,
    defaultBranch: run.defaultBranch,
    workflowName: run.workflowOrPipelineName,
    runUrl: run.runUrl,
    headSha: run.headSha,
  });

  let announcementTs: string | null = null;
  let slackNotifier: SlackNotifier | null = null;

  if (destination.provider === 'slack') {
    const slackAnnouncement = await postSlackInvestigationAnnouncement({
      destination,
      text: announcementText,
      automationLabel,
    });
    if (slackAnnouncement) {
      announcementTs = slackAnnouncement.messageTs;
      slackNotifier = slackAnnouncement.slack;
    }
  } else {
    announcementTs = await postNonSlackInvestigationAnnouncement({
      destination,
      text: announcementText,
    });
  }

  if (announcementTs) {
    try {
      await upsertBackgroundAutomationSlackThread(db, {
        surface: destination.provider,
        automationKey: 'ci_failure_triage',
        slackChannelId: destination.channelId,
        threadTs: announcementTs,
        summaryText: announcementText,
        postedAt: new Date(),
        metadata: {
          triggeringRunUrl: run.runUrl,
          sourceControlProvider: run.provider,
        },
      });
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Failed to track investigation announcement thread: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const channelId = destination.channelId;
  const announcementPayloadFields = buildAnnouncementTaskPayloadFields({
    destination,
    announcementMessageId: announcementTs,
  });

  try {
    const launchResult = await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: run.repositoryFullName,
            environmentId,
            selectedRepositories: [run.repositoryFullName],
            ...(run.provider !== 'github'
              ? { sourceControlProvider: run.provider }
              : {}),
            description: buildCiFailureTriagePrompt({
              channelId,
              repositoryFullNames: [run.repositoryFullName],
              repositoryCoverage,
              trigger: 'webhook',
              triggeringRun: {
                repositoryFullName: run.repositoryFullName,
                workflowName: run.workflowOrPipelineName,
                runUrl: run.runUrl,
                headBranch: run.headBranch,
                headSha: run.headSha,
                provider: run.provider,
              },
              hasAnnouncementThread: announcementTs !== null,
              destinationProvider: destination.provider,
            }),
            ...announcementPayloadFields,
            visibleInTranscript: false,
          },
        },
        initiator: { kind: 'automation', key: 'ci_failure_triage' },
        workflow: 'standard',
        surface: taskSurfaceForProvider(run.provider),
        trigger: 'webhook',
        visibility: 'hidden',
        ...(destination.provider === 'slack' && announcementTs
          ? {
              channels: {
                slackChannelId: channelId,
                slackThreadTs: announcementTs,
              },
            }
          : {}),
      },
      {
        launchClass: 'automation',
      },
    );

    await recordAutomationRunOutcome(db, {
      key: 'ci_failure_triage',
      status: 'succeeded',
      at: new Date(),
    });

    if (announcementTs && destination.provider === 'slack' && slackNotifier) {
      await refreshAutomationRootFooter({
        slack: slackNotifier,
        channelId,
        messageTs: announcementTs,
        automationLabel,
        taskUrl: getTaskUrl({
          taskId: launchResult.taskId,
          utm: { source: 'slack', campaign: 'slack.thread_reply' },
        }),
        taskId: launchResult.taskId,
      }).catch((error) => {
        console.warn(
          `${LOG_PREFIX} Failed to update investigation announcement footer: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    return {
      status: 'ok',
      message: `Launched CI failure triage for ${run.repositoryFullName}`,
      taskId: launchResult.taskId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await releaseCiFailureTriageInvestigation({
      provider: run.provider,
      repositoryFullName: run.repositoryFullName,
      fingerprint,
    }).catch((releaseError: unknown) => {
      console.warn(
        `${LOG_PREFIX} Failed to release investigation claims after launch error: ${
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError)
        }`,
      );
    });

    await recordAutomationRunOutcome(db, {
      key: 'ci_failure_triage',
      status: 'failed',
      at: new Date(),
      error: message,
    }).catch((completionError: unknown) => {
      console.warn(
        `${LOG_PREFIX} Failed to record CI failure triage outcome: ${
          completionError instanceof Error
            ? completionError.message
            : String(completionError)
        }`,
      );
    });

    if (announcementTs) {
      await postAnnouncementThreadReply({
        destination,
        announcementMessageId: announcementTs,
        text: "I couldn't start the investigation for this failure. I'll pick it up on the next failing run or a manual scan from the Automations page.",
        slack: slackNotifier,
      });
    }

    console.error(
      `${LOG_PREFIX} Failed to launch CI failure triage for ${run.repositoryFullName}: ${message}`,
    );

    return { status: 'error', message };
  }
}

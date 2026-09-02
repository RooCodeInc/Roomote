import {
  enqueueTask,
  getOrCreateFastAgentSession,
} from '@roomote/cloud-agents/server';
import {
  db,
  and,
  customAutomations,
  discordInstallationChannels,
  environments,
  eq,
  getCustomAutomationById,
  getCustomAutomationFrequency,
  CUSTOM_AUTOMATION_LAUNCH_STALE_CLAIM_MS,
  listEnabledCustomAutomations,
  recordCustomAutomationRunOutcome,
  tryClaimCustomAutomationLaunch,
  type CustomAutomation,
  slackInstallationChannels,
  slackInstallations,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  isConfiguredAutomationTarget,
  isBackgroundAutomationUserTargetKind,
  isCommunicationAutomationTarget,
  resolveEvalHarnessSelection,
  TaskPayloadKind,
  type AutomationTarget,
  type CommunicationProvider,
  type FastAgentConversation,
} from '@roomote/types';

import {
  buildDestinationPromptContext,
  buildDestinationTaskPayloadFields,
  findTeamsConversationRoute,
  listConnectedCommunicationProviders,
  type ResolvedAutomationDestination,
} from './destination';
import {
  isCronRunDue,
  resolveDeploymentTimeZone,
  validateCronExpression,
  type ResolvedDeploymentTimeZone,
} from './custom-automation-schedule';
import { DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL, isRunDue } from './scheduling-utils';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunNowResult,
  type AutomationRunOpts,
} from './types';
import { findUserDirectMessageDestination } from '../lib/user-direct-message';
import { createDiscordCommunicationProviderFromRuntimeCredentials } from '../lib/discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '../lib/teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from '../lib/telegram-communication';
import type { FastAgentParentEvent } from '../lib/fast-agent-parent-event';
import { enqueueFastAgentParentEvent } from '../lib/fast-agent-parent-event-queue';
import { recordFastAgentConversationMessage } from '../lib/fast-agent-provider-message';

const LOG_PREFIX = '[custom-automations]';

class CustomAutomationClaimSettlementError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'CustomAutomationClaimSettlementError';
  }
}

const PROVIDER_LABELS: Record<CommunicationProvider, string> = {
  discord: 'Discord',
  slack: 'Slack',
  teams: 'Teams',
  telegram: 'Telegram',
};

const WINDOW_DAYS: Record<string, number> = {
  every_hour: 1 / 24,
  every_6_hours: 6 / 24,
  daily: 1,
  weekly: 7,
};

function scheduleHourLocalForFrequency(frequency: string): number {
  if (frequency === 'daily' || frequency === 'weekly') {
    return DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL;
  }

  // isRunDue always requires the local hour boundary; hour 0 means any time
  // after midnight local is eligible, so hourly windows run as soon as due.
  return 0;
}

async function resolveDestination(
  target: AutomationTarget,
): Promise<ResolvedAutomationDestination | null> {
  if (!target.provider || !target.externalRef) {
    return null;
  }

  const provider = target.provider as CommunicationProvider;
  if (
    provider !== 'slack' &&
    provider !== 'discord' &&
    provider !== 'teams' &&
    provider !== 'telegram'
  ) {
    return null;
  }

  if (isBackgroundAutomationUserTargetKind(target.targetKind)) {
    const destination = await findUserDirectMessageDestination(
      provider,
      target.externalRef,
    );
    return destination
      ? { provider, ...destination, source: 'automation_target' }
      : null;
  }

  if (provider === 'slack') {
    const channel = await db.query.slackInstallationChannels.findFirst({
      where: eq(slackInstallationChannels.channelId, target.externalRef),
      columns: { id: true },
      with: {
        slackInstallation: {
          columns: { isActive: true, teamId: true },
        },
      },
    });
    return channel?.slackInstallation.isActive
      ? {
          provider,
          channelId: target.externalRef,
          teamId: channel.slackInstallation.teamId,
          source: 'automation_target',
        }
      : null;
  }

  if (provider === 'teams') {
    const route = await findTeamsConversationRoute(target.externalRef);
    if (!route) {
      return null;
    }

    return {
      provider,
      channelId: target.externalRef,
      teamId: route.workspaceId,
      source: 'automation_target',
      serviceUrl: route.serviceUrl,
    };
  }

  return {
    provider,
    channelId: target.externalRef,
    source: 'automation_target',
    ...(typeof target.metadata?.serviceUrl === 'string'
      ? { serviceUrl: target.metadata.serviceUrl }
      : {}),
  };
}

function buildDefaultReportPresentationGuidance(
  hasDestination: boolean,
): string {
  const channelGuidance = hasDestination
    ? '\n- The first `send_chat_reply` is the report root and must stand alone. If important supporting detail would make it too long, keep the root concise and send the detail in follow-up replies in the same thread with clear headings. Keep essential conclusions and required actions in the root.'
    : '';

  return `<default_report_presentation>
These are defaults, not requirements that override the automation request above. Before applying them, check the request for explicit guidance about format, structure, length, tone, audience, or where details should appear. On any conflict, follow the request. Apply these defaults only where the request is silent.

- Lead with the result or most important takeaway in 1-2 sentences.
- Keep the primary report concise, normally no more than about 250 words.
- When the report has multiple topics, use 2-4 short bold Markdown headings with bullets underneath them.
- Keep bullets short and put one finding, decision, or action in each bullet.
- Prioritize decision-useful findings. Omit routine methodology, exhaustive test transcripts, and repeated conclusions unless the request asks for them or they materially support the result.
- If the request explicitly requires a clean or no-action report, say so briefly and include only the most useful supporting evidence or caveats.
- Use inline links with descriptive labels instead of raw URLs when possible.${channelGuidance}
</default_report_presentation>`;
}

/**
 * Adds default reporting guidance to every custom automation prompt and,
 * when configured, makes its destination conversation available for
 * interruption-worthy results.
 *
 * A custom automation may intentionally omit a report destination. When it
 * does, prefer the admin who created/enabled it as a private fallback so an
 * enabled automation does not disappear from the communication surface.
 */
async function resolveOwnerFallbackDestination(
  ownerUserId: string | null,
): Promise<ResolvedAutomationDestination | null> {
  if (!ownerUserId) {
    return null;
  }

  const connectedProviders = await listConnectedCommunicationProviders();
  for (const provider of connectedProviders) {
    try {
      const destination = await findUserDirectMessageDestination(
        provider,
        ownerUserId,
      );
      if (destination) {
        return {
          provider,
          ...destination,
          source: 'automation_target',
        };
      }
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Failed to resolve owner DM on ${provider}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return null;
}

function buildCustomAutomationDescription(
  prompt: string,
  destination: ResolvedAutomationDestination | null,
  options: { allRepositories: boolean },
): string {
  const presentationGuidance = buildDefaultReportPresentationGuidance(
    destination !== null,
  );

  if (!destination) {
    return `${prompt}

${presentationGuidance}`;
  }

  const promptContext = buildDestinationPromptContext(destination);
  const orgWideSuggestionInstruction = options.allRepositories
    ? ' This run spans all active repositories. Every launchable suggestion must include the concrete `targetRepositoryFullName` that owns the work so Roomote can start it in the matching environment.'
    : '';

  return `${prompt}

${presentationGuidance}

<task_context>
  <source>background-automation</source>
  <${promptContext.channelTag}>${destination.channelId}</${promptContext.channelTag}>
</task_context>

The ${promptContext.surfaceLabel} conversation above is available for reports through \`send_chat_reply\`; do not use \`${promptContext.postToolName}\` and do not post anywhere else. Default to finishing silently. Interrupt the conversation only when there is something a human should see now: a concrete actionable or important finding, a meaningful completed result, a durable blocker, or required user input. Routine success, healthy status, no-change results, and findings that are neither actionable nor important should not produce a message unless the automation request explicitly asks for them. Stay silent while work is in flight: send no opening acknowledgement and do not post progress updates. If you do report, your first message creates this run's thread in that conversation, so make it one self-contained message that stands alone for readers who have not seen this task; later messages and user replies continue that same thread. Write the report as the result itself, like a teammate sharing what they found or did: do not mention this automation, the schedule, the task, or that anything requested the work; the message footer already attributes the automation. Lead with the outcome, not with framing like "Automation requested ..." or "Outcome: ...".${orgWideSuggestionInstruction}`;
}

function isFastDeliveryTarget(target: AutomationTarget): boolean {
  return isCommunicationAutomationTarget(target);
}

async function buildFastAutomationConversation(params: {
  automation: CustomAutomation;
  eventId: string;
  destination: ResolvedAutomationDestination | null;
  target: AutomationTarget | null;
}): Promise<{
  conversation: FastAgentConversation;
  rootMessageId?: string;
}> {
  const { automation, destination, eventId, target } = params;
  if (!destination) {
    return {
      conversation: {
        surface: 'automation',
        workspaceId: automation.id,
        conversationId: eventId,
      },
    };
  }

  if (destination.provider === 'slack') {
    if (!destination.teamId) {
      throw new Error('Slack destination routing is incomplete.');
    }
    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.isActive, true),
        eq(slackInstallations.teamId, destination.teamId),
      ),
      columns: { botAccessToken: true, teamId: true },
    });
    if (!installation?.botAccessToken) {
      throw new Error('Slack is not connected.');
    }
    return {
      conversation: {
        surface: 'slack',
        workspaceId: installation.teamId,
        conversationId: eventId,
        replyTarget: {
          channelId: destination.channelId,
        },
      },
    };
  }

  if (destination.provider === 'discord') {
    const provider =
      await createDiscordCommunicationProviderFromRuntimeCredentials();
    if (!provider) {
      throw new Error('Discord is not connected.');
    }
    if (target?.targetKind === 'discord_user') {
      const posted = await provider.postMessage({
        channelId: destination.channelId,
        text: `${automation.name} is running.`,
        textFormat: 'markdown',
        idempotencyKey: `fast-automation-root:${eventId}`,
      });
      return {
        rootMessageId: posted.messageId,
        conversation: {
          surface: 'discord',
          workspaceId: 'dm',
          conversationId: eventId,
          replyTarget: { channelId: destination.channelId },
        },
      };
    }

    const channel = await db.query.discordInstallationChannels.findFirst({
      where: eq(discordInstallationChannels.channelId, destination.channelId),
      columns: { id: true },
      with: {
        installation: { columns: { guildId: true, isActive: true } },
      },
    });
    if (!channel?.installation.isActive) {
      throw new Error('Discord destination is no longer available.');
    }
    const thread = await provider.createTaskThread({
      channelId: destination.channelId,
      name: automation.name,
      initialText: `${automation.name} is running in Fast mode.`,
    });
    return {
      ...(thread.messageId ? { rootMessageId: thread.messageId } : {}),
      conversation: {
        surface: 'discord',
        workspaceId: channel.installation.guildId,
        conversationId: thread.channelId,
        replyTarget: {
          channelId: destination.channelId,
          threadId: thread.channelId,
        },
      },
    };
  }

  if (destination.provider === 'teams') {
    if (!destination.serviceUrl || !destination.teamId) {
      throw new Error('Teams destination routing is incomplete.');
    }
    const provider =
      await createTeamsCommunicationProviderFromRuntimeCredentials();
    if (!provider) {
      throw new Error('Teams is not connected.');
    }
    const posted = await provider.postMessage({
      channelId: destination.channelId,
      serviceUrl: destination.serviceUrl,
      text: `${automation.name} is running.`,
      textFormat: 'markdown',
    });
    const threaded = target?.targetKind === 'teams_channel';
    return {
      rootMessageId: posted.messageId,
      conversation: {
        surface: 'teams',
        workspaceId: destination.teamId,
        conversationId: eventId,
        replyTarget: {
          channelId: destination.channelId,
          ...(threaded ? { threadId: posted.messageId } : {}),
          serviceUrl: destination.serviceUrl,
        },
      },
    };
  }

  if (destination.provider === 'telegram') {
    const provider =
      await createTelegramCommunicationProviderFromRuntimeCredentials();
    if (!provider) {
      throw new Error('Telegram is not connected.');
    }
    return {
      conversation: {
        surface: 'telegram',
        workspaceId: destination.channelId,
        conversationId: eventId,
        replyTarget: { channelId: destination.channelId },
      },
    };
  }

  throw new Error('Fast delivery does not support this destination.');
}

async function runFastCustomAutomation(params: {
  automation: CustomAutomation;
  destination: ResolvedAutomationDestination | null;
  eventClaimedAt: Date;
  launchClaimedAt: Date;
  trigger: 'schedule' | 'manual';
}): Promise<void> {
  if (!params.automation.createdByUserId) {
    throw new Error('Fast automation run-as user is not configured.');
  }
  const eventId = `${params.automation.id}:${params.eventClaimedAt.toISOString()}`;
  const { conversation, rootMessageId } = await buildFastAutomationConversation(
    {
      automation: params.automation,
      eventId,
      destination: params.destination,
      target: isConfiguredAutomationTarget(params.automation.target)
        ? params.automation.target
        : null,
    },
  );
  try {
    const session = await getOrCreateFastAgentSession({
      userId: params.automation.createdByUserId,
      conversation,
    });
    if (rootMessageId) {
      await recordFastAgentConversationMessage({
        sessionId: session.id,
        conversation,
        messageId: rootMessageId,
      });
    }
    const event: FastAgentParentEvent = {
      type: 'automation_triggered',
      eventId,
      automationId: params.automation.id,
      automationName: params.automation.name,
      launchClaimedAt: params.launchClaimedAt.toISOString(),
      prompt: params.automation.prompt,
      trigger: params.trigger,
      ...(params.automation.model
        ? { defaultTaskModel: params.automation.model }
        : {}),
      ...(rootMessageId ? { rootMessageId } : {}),
    };
    await enqueueFastAgentParentEvent({
      parent: { sessionId: session.id, conversation },
      event,
    });
  } catch (error) {
    const message = `${params.automation.name} failed: ${error instanceof Error ? error.message : String(error)}`;
    try {
      if (conversation.surface === 'discord' && rootMessageId) {
        const provider =
          await createDiscordCommunicationProviderFromRuntimeCredentials();
        await provider?.editMessage({
          channelId:
            conversation.replyTarget.threadId ??
            conversation.replyTarget.channelId,
          messageId: rootMessageId,
          text: message,
        });
      } else if (conversation.surface === 'teams' && rootMessageId) {
        const provider =
          await createTeamsCommunicationProviderFromRuntimeCredentials();
        const route = await findTeamsConversationRoute(
          conversation.replyTarget.channelId,
          conversation.workspaceId,
        );
        const persistedDirectMessageServiceUrl = conversation.replyTarget
          .threadId
          ? undefined
          : conversation.replyTarget.serviceUrl;
        const serviceUrl =
          route?.serviceUrl ?? persistedDirectMessageServiceUrl;
        if (provider && serviceUrl) {
          await provider.updateMessage({
            channelId: conversation.replyTarget.channelId,
            messageId: rootMessageId,
            serviceUrl,
            text: message,
            textFormat: 'markdown',
          });
        }
      } else if (conversation.surface === 'telegram') {
        const provider =
          await createTelegramCommunicationProviderFromRuntimeCredentials();
        await provider?.postMessage({
          channelId: conversation.replyTarget.channelId,
          text: message,
          textFormat: 'markdown',
        });
      }
    } catch (updateError) {
      console.warn(
        `${LOG_PREFIX} Failed to update Fast automation error output: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
      );
    }
    throw error;
  }
}

async function launchCustomAutomationRow(
  automation: CustomAutomation,
  opts: AutomationRunOpts,
  scheduleContext?: ResolvedDeploymentTimeZone,
): Promise<AutomationJobResult> {
  const result = emptyJobResult();
  const frequency = getCustomAutomationFrequency(automation);
  const fastExecution = automation.executionMode === 'fast';

  if (automation.scheduleMode !== 'cron' && frequency === 'off') {
    result.skippedReason = 'Automation is disabled.';
    return result;
  }

  if (!opts.manualTrigger) {
    const timezone = scheduleContext ?? (await resolveDeploymentTimeZone());
    const now = new Date();
    const cronBaseline = new Date(
      Math.max(
        automation.lastRunAt?.getTime() ?? automation.createdAt.getTime(),
        timezone.updatedAt?.getTime() ?? 0,
      ),
    );
    const presetLastRunAt = timezone.updatedAt
      ? new Date(
          Math.max(
            automation.lastRunAt?.getTime() ?? 0,
            timezone.updatedAt.getTime(),
          ),
        )
      : automation.lastRunAt;
    const due =
      automation.scheduleMode === 'cron'
        ? Boolean(
            automation.cronExpression &&
            isCronRunDue({
              expression: validateCronExpression(
                automation.cronExpression,
                timezone.timeZone,
              ),
              timeZone: timezone.timeZone,
              now,
              baseline: cronBaseline,
            }),
          )
        : isRunDue({
            now,
            timeZone: timezone.timeZone,
            frequency,
            lastRunAt: presetLastRunAt,
            scheduleHourLocal: scheduleHourLocalForFrequency(frequency),
            windowDays: WINDOW_DAYS,
          });

    if (!due) {
      result.skippedReason = 'Not due yet.';
      return result;
    }
  }

  if (
    fastExecution &&
    automation.launchClaimedAt &&
    Date.now() - automation.launchClaimedAt.getTime() >=
      CUSTOM_AUTOMATION_LAUNCH_STALE_CLAIM_MS
  ) {
    const message = 'The previous Fast automation run was interrupted.';
    result.skippedReason = message;
    result.errors.push(message);
    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'failed',
      error: message,
      lastLaunchedTaskId: null,
      lastRunAt: automation.launchClaimedAt,
      launchClaimedAt: automation.launchClaimedAt,
    });
    return result;
  }

  if (
    !fastExecution &&
    !automation.allRepositories &&
    !automation.environmentId
  ) {
    result.skippedReason = 'Environment is not configured.';
    result.errors.push('Environment is not configured.');
    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'failed',
      error: 'Environment is not configured.',
    });
    return result;
  }

  const environment =
    fastExecution || automation.allRepositories
      ? null
      : await db.query.environments.findFirst({
          columns: { id: true },
          where: eq(environments.id, automation.environmentId!),
        });

  if (!fastExecution && !automation.allRepositories && !environment) {
    result.skippedReason = 'Environment no longer exists.';
    result.errors.push('Environment no longer exists.');
    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'failed',
      error: 'Environment no longer exists.',
    });
    return result;
  }

  // A report destination is optional. Prefer a private DM to the admin who
  // created/enabled the automation so an enabled run still has a chat-facing
  // result; if that admin has no linked DM, preserve the task-UI fallback.
  let destination: ResolvedAutomationDestination | null = null;
  if (isConfiguredAutomationTarget(automation.target)) {
    const deferSlackChannelResolution =
      !fastExecution &&
      automation.target.provider === 'slack' &&
      automation.target.targetKind === 'slack_channel';
    if (fastExecution && !isFastDeliveryTarget(automation.target)) {
      const message = `${PROVIDER_LABELS[automation.target.provider as CommunicationProvider]} report destinations of this type are not supported in Fast mode.`;
      result.skippedReason = message;
      result.errors.push(message);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      return result;
    }

    // Sandbox reports are late-bound: a clean run may intentionally never
    // contact Slack, so validate installation and channel access only when its
    // first send_chat_reply actually creates the report root.
    destination = deferSlackChannelResolution
      ? {
          provider: 'slack',
          channelId: automation.target.externalRef,
          source: 'automation_target',
        }
      : await resolveDestination(automation.target);
    if (!destination) {
      const message = isBackgroundAutomationUserTargetKind(
        automation.target.targetKind,
      )
        ? `The automation owner does not have a linked ${PROVIDER_LABELS[automation.target.provider as CommunicationProvider]} account that can receive direct messages.`
        : automation.target.provider === 'teams'
          ? 'Teams report destination is missing a resolvable service URL.'
          : 'Report destination could not be resolved.';
      result.skippedReason = message;
      result.errors.push(message);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      return result;
    }

    const connected = deferSlackChannelResolution
      ? null
      : await listConnectedCommunicationProviders();
    if (connected && !connected.includes(destination.provider)) {
      const message = `${destination.provider} is not connected.`;
      result.skippedReason = message;
      result.errors.push(message);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      return result;
    }
  } else if (!fastExecution) {
    destination = await resolveOwnerFallbackDestination(
      automation.createdByUserId,
    );
  }

  // The short claim fence prevents concurrent launchers from double-launching
  // without blocking a due run behind a previous task that still appears active.
  const launchClaimedAt = await tryClaimCustomAutomationLaunch(
    automation.id,
    automation.lastRunAt,
  );
  if (!launchClaimedAt) {
    result.skippedReason = 'Another launch is already in progress.';
    return result;
  }

  // A persisted model override is validated on save; a value that no longer
  // parses is ignored so a stale pin degrades to the deployment default
  // instead of blocking the scheduled run.
  const modelSelection = automation.model
    ? resolveEvalHarnessSelection({ model: automation.model })
    : null;
  if (modelSelection && !modelSelection.ok) {
    console.warn(
      `${LOG_PREFIX} Ignoring invalid model override "${automation.model}" on automation ${automation.id}: ${modelSelection.error}`,
    );
  }
  const modelOverride = modelSelection?.ok ? modelSelection : null;
  const eventClaimedAt =
    fastExecution &&
    opts.manualTrigger &&
    automation.lastError &&
    automation.lastRunAt
      ? automation.lastRunAt
      : launchClaimedAt;

  try {
    if (fastExecution) {
      await db
        .update(customAutomations)
        .set({ lastLaunchedTaskId: null })
        .where(
          and(
            eq(customAutomations.id, automation.id),
            eq(customAutomations.launchClaimedAt, launchClaimedAt),
          ),
        );
      await runFastCustomAutomation({
        automation,
        destination,
        eventClaimedAt,
        launchClaimedAt,
        trigger: opts.manualTrigger ? 'manual' : 'schedule',
      });
      result.queued = true;
      return result;
    }

    const launchResult = await enqueueTask({
      task: {
        type: TaskPayloadKind.StandardTask,
        ...(modelOverride?.harness ? { harness: modelOverride.harness } : {}),
        payload: {
          repo: automation.allRepositories ? ALL_REPOSITORIES : '',
          ...(automation.environmentId
            ? { environmentId: automation.environmentId }
            : {}),
          description: buildCustomAutomationDescription(
            automation.prompt,
            destination,
            {
              allRepositories: automation.allRepositories,
            },
          ),
          ...(destination
            ? buildDestinationTaskPayloadFields(destination)
            : {}),
          // customAutomationId authorizes the Slack late-bound thread flow:
          // the run's first send_chat_reply posts a root message in the
          // destination channel and binds it as the task thread, so later
          // updates continue the thread and user replies route back into the
          // task. The channel/slackChannel payload fields give the sandbox
          // its Slack reply context (ROOMOTE_SLACK_CHANNEL).
          ...(destination ? { customAutomationId: automation.id } : {}),
          ...(destination?.provider === 'slack'
            ? {
                channel: destination.channelId,
                slackChannel: destination.channelId,
                ...(destination.teamId
                  ? {
                      teamId: destination.teamId,
                      slackTeamId: destination.teamId,
                    }
                  : {}),
              }
            : {}),
          ...(modelOverride?.harnessModelOverrides
            ? { harnessModelOverrides: modelOverride.harnessModelOverrides }
            : {}),
        },
      },
      title: automation.name,
      initiator: {
        kind: 'automation',
        key: 'custom_automation',
        actor: {
          externalId: automation.id,
          displayName: automation.name,
        },
      },
      workflow: 'standard',
      surface: 'system',
      trigger: opts.manualTrigger ? 'manual' : 'schedule',
      ...(destination?.provider === 'slack'
        ? { channels: { slackChannelId: destination.channelId } }
        : {}),
    });

    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'succeeded',
      lastLaunchedTaskId: launchResult.taskId,
      launchClaimedAt,
    });

    result.launchedTaskId = launchResult.taskId;
    result.completed = true;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const settled = await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
        lastRunAt: eventClaimedAt,
        launchClaimedAt,
      });
      if (!settled) {
        throw new Error('The launch claim is no longer current.');
      }
    } catch (settlementError) {
      throw new CustomAutomationClaimSettlementError(
        `Failed to settle custom automation ${automation.id} after: ${message}`,
        settlementError,
      );
    }

    result.errors.push(message);
    result.skippedReason = message;
    return result;
  }
}

export async function customAutomationsJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting custom automations evaluator`);

  const result = emptyJobResult();
  const rows = await listEnabledCustomAutomations();

  if (rows.length === 0) {
    result.skippedReason = 'No enabled custom automations.';
    return result;
  }

  const scheduleContext = await resolveDeploymentTimeZone();
  let processed = 0;
  let skipped = 0;

  for (const automation of rows) {
    try {
      const rowResult = await launchCustomAutomationRow(
        automation,
        opts,
        scheduleContext,
      );

      if (rowResult.launchedTaskId) {
        result.launchedTaskId ??= rowResult.launchedTaskId;
        processed++;
      } else if (rowResult.queued) {
        result.queued = true;
        processed++;
      } else if (rowResult.completed) {
        result.completed = true;
        processed++;
      } else if (rowResult.errors.length > 0) {
        result.errors.push(
          ...rowResult.errors.map((e) => `${automation.name}: ${e}`),
        );
        skipped++;
      } else {
        skipped++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${automation.name}: ${message}`);
      if (!(error instanceof CustomAutomationClaimSettlementError)) {
        await recordCustomAutomationRunOutcome(db, {
          id: automation.id,
          status: 'failed',
          error: message,
        });
      }
      console.error(`${LOG_PREFIX} Failed ${automation.id}: ${message}`);
    }
  }

  console.log(
    `${LOG_PREFIX} Completed: ${processed} launched, ${skipped} skipped, ${result.errors.length} errors`,
  );

  return result;
}

export async function runCustomAutomationNow(
  id: string,
): Promise<AutomationRunNowResult> {
  const automation = await getCustomAutomationById(id);

  if (!automation) {
    return { outcome: 'failed', error: 'Custom automation was not found.' };
  }

  if (!automation.enabled) {
    return {
      outcome: 'failed',
      error:
        'This custom automation is disabled. Enable and save it before running.',
    };
  }

  try {
    const result = await launchCustomAutomationRow(automation, {
      manualTrigger: true,
    });

    if (result.launchedTaskId) {
      return { outcome: 'launched', taskId: result.launchedTaskId };
    }

    if (result.errors.length > 0) {
      return { outcome: 'failed', error: result.errors.join('; ') };
    }

    if (result.skippedReason) {
      return { outcome: 'skipped', reason: result.skippedReason };
    }

    if (result.queued) {
      return { outcome: 'queued' };
    }

    if (result.completed) {
      return { outcome: 'completed' };
    }

    return { outcome: 'skipped', reason: 'Nothing to do.' };
  } catch (error) {
    return {
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

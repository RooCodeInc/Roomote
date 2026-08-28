import {
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
  activeRunStatuses,
  isDeploymentReadOnlyError,
  type QueuedCommunicationMessage,
} from '@roomote/types';
import {
  and,
  db,
  eq,
  inArray,
  isNull,
  or,
  releaseWorkItemClaim,
  sql,
  taskRuns,
} from '@roomote/db/server';
import type {
  DiscordInteraction,
  DiscordUser,
} from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { findDiscordMappedUserId } from '@roomote/sdk/server';
import { parsePrReviewActionCallbackData } from '@roomote/types';

import { apiLogger } from '../../logging.js';
import { hasCommunicationsFastModeDefault } from '../fast-agent-entry.js';
import { launchClaimedSuggestedTask } from '../tasks/suggestion-launch.js';
import {
  claimCurrentThreadSuggestionByMessage,
  findCurrentThreadSuggestionIdByMessage,
  type ClaimedCurrentThreadSuggestion,
} from '../tasks/current-thread-suggestion-reaction.js';
import { stopTaskRun } from '../tasks/task-stop.js';
import { replyToDiscordEvent } from './replies.js';
import {
  handleDiscordRoutingCallback,
  parseDiscordRouteCallbackData,
} from './routing-confirmation.js';
import {
  hasPendingDiscordRequestUserInputCallback,
  tryHandleDiscordRequestUserInputCallback,
} from './request-user-input.js';
import type { DiscordChannelContext } from './task-launch.js';
import {
  discordMetadataForChannel,
  resolveDiscordChannelContext,
  resolveDiscordWorkspace,
} from './task-launch.js';
import { claimDiscordSuggestionLaunch } from './setup-suggestions.js';
import { startNewDiscordTask } from './task-orchestration.js';
import {
  getDiscordFastConversationId,
  startDiscordFastAgentResponse,
} from './fast-agent.js';

/** Match Slack cancel reaction (`DEFAULT_SLACK_CANCEL_EMOJI`). */
const DISCORD_CANCEL_REACTION_EMOJI = 'x';

function parseCancelCallbackData(value: string | undefined): number | null {
  const match = /^discord:cancel:(\d+)$/u.exec(value ?? '');
  if (!match) return null;
  const runId = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

async function findCancelableDiscordRun(runId: number, channelId: string) {
  return db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.id, runId),
      sql`${taskRuns.payload}->>'communicationProvider' = 'discord'`,
      or(
        sql`${taskRuns.payload}->>'communicationThreadId' = ${channelId}`,
        and(
          sql`${taskRuns.payload}->>'communicationThreadId' IS NULL`,
          sql`${taskRuns.payload}->>'communicationChannelId' = ${channelId}`,
        ),
      ),
      inArray(taskRuns.status, [...activeRunStatuses]),
      isNull(taskRuns.canceledAt),
    ),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
      payload: true,
    },
    with: {
      task: { columns: { initiatorUserId: true } },
    },
  });
}

function getDiscordCancelReactionTarget(payload: unknown): {
  channelId: string;
  messageId: string;
} | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const channelId =
    typeof (payload as { discordReactionChannelId?: unknown })
      .discordReactionChannelId === 'string'
      ? (
          payload as { discordReactionChannelId: string }
        ).discordReactionChannelId.trim()
      : '';
  const messageId =
    typeof (payload as { discordReactionMessageId?: unknown })
      .discordReactionMessageId === 'string'
      ? (
          payload as { discordReactionMessageId: string }
        ).discordReactionMessageId.trim()
      : '';

  if (!channelId || !messageId) {
    return null;
  }

  return { channelId, messageId };
}

async function addDiscordCancelReactionBestEffort(input: {
  provider: DiscordCommunicationProvider;
  payload: unknown;
}): Promise<void> {
  const target = getDiscordCancelReactionTarget(input.payload);
  if (!target) {
    return;
  }

  try {
    await input.provider.addReaction({
      channelId: target.channelId,
      messageId: target.messageId,
      name: DISCORD_CANCEL_REACTION_EMOJI,
    });
  } catch (error) {
    apiLogger.warn(
      `[discord] Failed to add cancel reaction for channel ${target.channelId} message ${target.messageId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function handleCancelCallback(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  interaction: DiscordInteraction;
  interactionDeferred: boolean;
  channel: DiscordChannelContext;
  runId: number;
}): Promise<void> {
  const channelId = input.interaction.channel_id;
  const run = channelId
    ? await findCancelableDiscordRun(input.runId, channelId)
    : null;
  if (!run) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text: 'That task is no longer running.',
    });
    return;
  }
  const user = input.interaction.member?.user ?? input.interaction.user;
  const mappedUserId = await findDiscordMappedUserId(user?.id);
  if (!mappedUserId) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text: 'Link your Discord account to Roomote before canceling tasks.',
    });
    return;
  }
  const taskOwnerUserId = run.task?.initiatorUserId ?? null;
  if (mappedUserId !== run.actingUserId && mappedUserId !== taskOwnerUserId) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text: 'Only the task owner or current task participant can cancel this task.',
    });
    return;
  }
  const cancelledByName =
    input.interaction.member?.nick?.trim() ||
    user?.global_name?.trim() ||
    user?.username;
  const result = await stopTaskRun({
    run,
    authUserId: mappedUserId,
    allowDirectCancelWithoutSandbox: true,
    // Provider Cancel is terminal: stop the turn and shut the sandbox down.
    terminate: true,
    cancelledBy: {
      ...(cancelledByName ? { name: cancelledByName } : {}),
      source: 'discord',
    },
  });
  const canceled =
    result.success || result.statusCode === 404 || result.statusCode === 409;
  if (canceled) {
    await addDiscordCancelReactionBestEffort({
      provider: input.provider,
      payload: run.payload,
    });
  }
  await replyToDiscordEvent({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: input.channel,
    interaction: {
      interaction: input.interaction,
      interactionDeferred: input.interactionDeferred,
    },
    text: canceled
      ? 'Canceled the task.'
      : 'Could not cancel the task — check the task page for its current state.',
  });
}

function parseSuggestionCallbackData(value: string | undefined): string | null {
  const match = /^idea:([^:]{1,80})$/u.exec(value ?? '');
  return match?.[1] ?? null;
}

async function handleSuggestionCallback(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  interaction: DiscordInteraction;
  channel: DiscordChannelContext;
  suggestionId: string;
}): Promise<void> {
  const sender = input.interaction.member?.user ?? input.interaction.user;
  const senderUserId = await findDiscordMappedUserId(sender?.id);
  if (!sender || !senderUserId || !input.interaction.channel_id) {
    await input.provider.postMessage({
      channelId: input.channel.parentChannelId ?? input.channel.channelId,
      ...(input.channel.parentChannelId
        ? { threadId: input.channel.channelId }
        : {}),
      text: 'Link your Roomote account before starting suggested tasks.',
    });
    return;
  }
  const suggestion = await claimDiscordSuggestionLaunch({
    suggestionId: input.suggestionId,
    channelId: input.interaction.channel_id,
  });
  if (!suggestion) {
    await input.provider.postMessage({
      channelId: input.channel.parentChannelId ?? input.channel.channelId,
      ...(input.channel.parentChannelId
        ? { threadId: input.channel.channelId }
        : {}),
      text: 'That idea was already started or is no longer available.',
    });
    return;
  }

  await launchClaimedDiscordSuggestion({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: input.channel,
    suggestion,
    sender,
    senderUserId,
    triggerId: input.interaction.id,
    senderDisplayName: input.interaction.member?.nick,
  });
}

async function launchClaimedDiscordSuggestion(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  suggestion: ClaimedCurrentThreadSuggestion;
  sender: DiscordUser;
  senderUserId: string;
  triggerId: string;
  senderDisplayName?: string | null;
}): Promise<void> {
  const suggestion = input.suggestion;
  const claimedAt = suggestion.launchClaimedAt;
  try {
    if (!input.channel.parentChannelId && !input.channel.isDirectMessage) {
      throw new Error(
        'Discord suggestion card is not inside a task-capable thread or DM.',
      );
    }
    // Guild cards live in a bot-created "Suggested tasks" thread: launch in
    // the parent channel so the task gets its own thread. DM cards launch in
    // the DM conversation itself, matching direct-message task entry.
    const launchChannel = input.channel.parentChannelId
      ? await resolveDiscordChannelContext(
          input.provider,
          input.channel.parentChannelId,
        )
      : input.channel;
    const promptText = [
      `Start this suggested task: ${suggestion.title}`,
      ...(suggestion.brief ? ['', suggestion.brief] : []),
      ...(suggestion.targetRepositoryFullName
        ? ['', `Target repository: ${suggestion.targetRepositoryFullName}`]
        : []),
      ...(suggestion.targetEnvironmentId
        ? ['', `Target environment: ${suggestion.targetEnvironmentId}`]
        : []),
      ...(suggestion.investigationContext
        ? ['', `Context: ${suggestion.investigationContext}`]
        : []),
    ].join('\n');
    const usesRouterLaunch = suggestion.usesRouterLaunch === true;
    let taskUrl: string | undefined;
    const launchResult = await launchClaimedSuggestedTask({
      suggestion: { id: suggestion.id, launchClaimedAt: claimedAt },
      policy: {
        usesRouterLaunch,
        userDefaultEnabled: usesRouterLaunch
          ? await hasCommunicationsFastModeDefault(input.senderUserId)
          : false,
        fastAvailable: true,
      },
      launch: async (launchMode) => {
        if (launchMode === 'fast') {
          const fastStart = await startDiscordFastAgentResponse({
            eventId: input.triggerId,
            question: promptText,
            sender: input.sender,
            senderUserId: input.senderUserId,
            provider: input.provider,
            applicationId: input.applicationId,
            channel: input.channel,
            metadata: discordMetadataForChannel({
              channel: input.channel,
              messageId: input.triggerId,
            }),
            conversationId: getDiscordFastConversationId(
              input.channel,
              input.triggerId,
            ),
            createAnchoredThread: false,
          });
          return fastStart.accepted
            ? { accepted: true, runId: null, taskId: null }
            : fastStart;
        }

        const queuedMessage: QueuedCommunicationMessage = {
          provider: 'discord',
          text: promptText,
          user:
            input.senderDisplayName?.trim() ||
            input.sender.global_name?.trim() ||
            input.sender.username,
          userId: input.senderUserId,
          ts: input.triggerId,
          channel: launchChannel.channelId,
          turnPolicy: { reactionsAllowed: true },
        };
        const workspaceOverride = suggestion.targetEnvironmentId
          ? await resolveDiscordWorkspace({
              type: 'environment',
              id: suggestion.targetEnvironmentId,
              name: suggestion.targetEnvironmentId,
            })
          : undefined;
        if (suggestion.targetEnvironmentId && !workspaceOverride) {
          throw new Error('The suggestion target environment is unavailable.');
        }
        const started = await startNewDiscordTask({
          provider: input.provider,
          applicationId: input.applicationId,
          requesterDiscordUserId: input.sender.id,
          launchOwnerUserId: input.senderUserId,
          queuedMessage,
          metadata: discordMetadataForChannel({
            channel: launchChannel,
            messageId: input.triggerId,
          }),
          channel: launchChannel,
          skipRoutingConfirmation: true,
          ...(workspaceOverride ? { workspaceOverride } : {}),
        });
        if (started.status !== 'started') {
          return { accepted: false };
        }
        taskUrl = started.taskUrl;
        return {
          accepted: true,
          runId: started.launchResult.id,
          taskId: started.launchResult.taskId,
        };
      },
    });

    if (launchResult.status === 'rejected') {
      if (launchResult.reason) {
        await input.provider.postMessage({
          channelId: input.channel.parentChannelId ?? input.channel.channelId,
          ...(input.channel.parentChannelId
            ? { threadId: input.channel.channelId }
            : {}),
          text: `Could not start “${suggestion.title}” — ${launchResult.reason}`,
        });
      }
      return;
    }
    if (launchResult.status === 'failed') {
      throw launchResult.error;
    }
    if (
      launchResult.status === 'finalize_lost' ||
      launchResult.status === 'finalize_failed'
    ) {
      apiLogger.warn(
        `[discord] Failed to finalize suggestion ${suggestion.id}; task ${launchResult.taskId ?? 'null'} (run ${launchResult.runId ?? 'null'}) — ${launchResult.cancelNote}`,
      );
      await input.provider.postMessage({
        channelId: input.channel.parentChannelId ?? input.channel.channelId,
        ...(input.channel.parentChannelId
          ? { threadId: input.channel.channelId }
          : {}),
        text:
          launchResult.mode === 'coding'
            ? `“${suggestion.title}” was already started elsewhere — this duplicate task was canceled.`
            : `“${suggestion.title}” was already started elsewhere.`,
      });
      return;
    }
    if (launchResult.mode === 'fast') {
      return;
    }
    await input.provider.postMessage({
      channelId: input.channel.parentChannelId ?? input.channel.channelId,
      ...(input.channel.parentChannelId
        ? { threadId: input.channel.channelId }
        : {}),
      text: input.channel.parentChannelId
        ? `Started “${suggestion.title}” in a new task thread.`
        : `Started “${suggestion.title}”.`,
      ...(taskUrl ? { buttons: [[{ text: 'Follow', url: taskUrl }]] } : {}),
    });
  } catch (error) {
    const blockedByReadOnly = isDeploymentReadOnlyError(error);
    await releaseWorkItemClaim(db, {
      id: suggestion.id,
      claimedAt,
    }).catch(() => undefined);
    apiLogger.warn(
      `[discord] Failed to launch suggestion ${suggestion.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    await input.provider.postMessage({
      channelId: input.channel.parentChannelId ?? input.channel.channelId,
      ...(input.channel.parentChannelId
        ? { threadId: input.channel.channelId }
        : {}),
      text: blockedByReadOnly
        ? MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE
        : `Could not start “${suggestion.title}” — try describing the task in a message instead.`,
    });
  }
}

export async function handleDiscordSuggestionReaction(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  channelId: string;
  messageId: string;
  eventId: string;
  sender: DiscordUser;
  senderDisplayName?: string | null;
}): Promise<boolean> {
  const suggestionId = await findCurrentThreadSuggestionIdByMessage({
    surface: 'discord',
    channelId: input.channelId,
    messageId: input.messageId,
  });
  if (!suggestionId) {
    return false;
  }

  const senderUserId = await findDiscordMappedUserId(input.sender.id);
  if (!senderUserId) {
    await input.provider.postMessage({
      channelId: input.channel.parentChannelId ?? input.channel.channelId,
      ...(input.channel.parentChannelId
        ? { threadId: input.channel.channelId }
        : {}),
      text: 'Link your Roomote account before starting suggested tasks.',
    });
    return true;
  }

  const claim = await claimCurrentThreadSuggestionByMessage({
    surface: 'discord',
    channelId: input.channelId,
    messageId: input.messageId,
  });
  if (claim.outcome === 'no_card') {
    return false;
  }
  if (claim.outcome === 'already_started') {
    await input.provider.postMessage({
      channelId: input.channel.parentChannelId ?? input.channel.channelId,
      ...(input.channel.parentChannelId
        ? { threadId: input.channel.channelId }
        : {}),
      text: 'That idea was already started or is no longer available.',
    });
    return true;
  }
  const suggestion = claim.suggestion;

  await launchClaimedDiscordSuggestion({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: input.channel,
    suggestion,
    sender: input.sender,
    senderUserId,
    triggerId: input.eventId,
    senderDisplayName: input.senderDisplayName,
  });
  return true;
}

export async function handleDiscordComponentInteraction(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  interaction: DiscordInteraction;
  interactionDeferred: boolean;
  channel: DiscordChannelContext;
}): Promise<'handled' | 'unsupported'> {
  const customId = input.interaction.data?.custom_id;
  if (hasPendingDiscordRequestUserInputCallback(customId)) {
    const sender = input.interaction.member?.user ?? input.interaction.user;
    const mappedUserId = sender?.id
      ? await findDiscordMappedUserId(sender.id)
      : null;
    await tryHandleDiscordRequestUserInputCallback({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      interaction: input.interaction,
      interactionDeferred: input.interactionDeferred,
      customId,
      userId: mappedUserId,
    });
    return 'handled';
  }
  const prReviewAction = parsePrReviewActionCallbackData(customId);
  if (prReviewAction) {
    const { handleDiscordPrReviewActionCallback } =
      await import('./pr-review-action.js');
    await handleDiscordPrReviewActionCallback({
      provider: input.provider,
      applicationId: input.applicationId,
      interaction: input.interaction,
      interactionDeferred: input.interactionDeferred,
      channel: input.channel,
      choice: prReviewAction.choice,
      nonce: prReviewAction.nonce,
    });
    return 'handled';
  }

  const cancelRunId = parseCancelCallbackData(customId);
  if (cancelRunId) {
    await handleCancelCallback({ ...input, runId: cancelRunId });
    return 'handled';
  }
  const routeCallback = parseDiscordRouteCallbackData(customId);
  if (routeCallback) {
    await handleDiscordRoutingCallback({
      provider: input.provider,
      applicationId: input.applicationId,
      interaction: input.interaction,
      interactionDeferred: input.interactionDeferred,
      callback: routeCallback,
    });
    return 'handled';
  }
  const suggestionId = parseSuggestionCallbackData(customId);
  if (suggestionId) {
    await handleSuggestionCallback({
      provider: input.provider,
      applicationId: input.applicationId,
      interaction: input.interaction,
      channel: input.channel,
      suggestionId,
    });
    return 'handled';
  }
  return 'unsupported';
}

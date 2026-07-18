import {
  activeRunStatuses,
  type QueuedCommunicationMessage,
} from '@roomote/types';
import {
  and,
  db,
  eq,
  finalizeWorkItemLaunched,
  inArray,
  isNull,
  or,
  releaseWorkItemClaim,
  sql,
  taskRuns,
} from '@roomote/db/server';
import type { DiscordInteraction } from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { findDiscordMappedUserId } from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import { cancelOrphanedWorkItemRunBestEffort } from '../tasks/orphaned-work-item-run.js';
import { stopTaskRun } from '../tasks/task-stop.js';
import { replyToDiscordEvent } from './replies.js';
import {
  handleDiscordRoutingCallback,
  parseDiscordRouteCallbackData,
} from './routing-confirmation.js';
import type { DiscordChannelContext } from './task-launch.js';
import {
  discordMetadataForChannel,
  resolveDiscordChannelContext,
} from './task-launch.js';
import { claimDiscordSuggestionLaunch } from './setup-suggestions.js';
import { startNewDiscordTask } from './task-orchestration.js';

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
      ...(suggestion.investigationContext
        ? ['', `Context: ${suggestion.investigationContext}`]
        : []),
    ].join('\n');
    const queuedMessage: QueuedCommunicationMessage = {
      provider: 'discord',
      text: promptText,
      user:
        input.interaction.member?.nick?.trim() ||
        sender.global_name?.trim() ||
        sender.username,
      userId: senderUserId,
      ts: input.interaction.id,
      channel: launchChannel.channelId,
      turnPolicy: { reactionsAllowed: true },
    };
    const started = await startNewDiscordTask({
      provider: input.provider,
      applicationId: input.applicationId,
      requesterDiscordUserId: sender.id,
      launchOwnerUserId: senderUserId,
      queuedMessage,
      metadata: discordMetadataForChannel({
        channel: launchChannel,
        messageId: input.interaction.id,
      }),
      channel: launchChannel,
      skipRoutingConfirmation: true,
    });
    if (started.status !== 'started') {
      await releaseWorkItemClaim(db, { id: suggestion.id, claimedAt });
      return;
    }
    const finalized = await finalizeWorkItemLaunched(db, {
      id: suggestion.id,
      taskId: started.launchResult.taskId,
      claimedAt,
    });
    if (!finalized) {
      const cancelNote = await cancelOrphanedWorkItemRunBestEffort(
        started.launchResult.id,
      );
      apiLogger.warn(
        `[discord] Lost suggestion launch fence for ${suggestion.id}; duplicate run ${started.launchResult.id} was orphaned — ${cancelNote}`,
      );
      await input.provider.postMessage({
        channelId: input.channel.parentChannelId ?? input.channel.channelId,
        ...(input.channel.parentChannelId
          ? { threadId: input.channel.channelId }
          : {}),
        text: `“${suggestion.title}” was already started elsewhere — this duplicate task was canceled.`,
      });
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
      ...(started.taskUrl
        ? { buttons: [[{ text: 'Follow', url: started.taskUrl }]] }
        : {}),
    });
  } catch (error) {
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
      text: `Could not start “${suggestion.title}” — try describing the task in a message instead.`,
    });
  }
}

export async function handleDiscordComponentInteraction(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  interaction: DiscordInteraction;
  interactionDeferred: boolean;
  channel: DiscordChannelContext;
}): Promise<'handled' | 'unsupported'> {
  const customId = input.interaction.data?.custom_id;
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

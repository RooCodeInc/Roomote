import { randomBytes } from 'node:crypto';

import {
  getAvailableEnvironments,
  getTaskUrl,
  type RoutingDecision,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';
import type { DiscordInteraction } from '@roomote/communication/discord-event';
import type {
  DiscordCommunicationProvider,
  DiscordTaskThread,
} from '@roomote/communication/discord-provider';
import { getRedis } from '@roomote/redis';
import { findDiscordMappedUserId } from '@roomote/sdk/server';
import type { QueuedCommunicationMessage } from '@roomote/types';

import type { DiscordEventCommunicationMetadata } from '@roomote/communication/discord-event';
import { findCommunicationTaskRunBySourceEvent } from '../tasks/communication-task-run-lookup.js';
import { replyToDiscordEvent } from './replies.js';
import {
  forgetPendingTaskThread,
  launchDiscordTask,
  reserveDiscordAnchoredThread,
  resolveDiscordWorkspace,
  type DiscordChannelContext,
} from './task-launch.js';

const DISCORD_IMMEDIATE_CONFIRM_CONFIDENCE = 0.95;
const DISCORD_CHANNEL_TYPE_ANNOUNCEMENT = 5;
const DISCORD_CHANNEL_TYPE_ANNOUNCEMENT_THREAD = 10;
const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;
const PENDING_ROUTE_TTL_SECONDS = 15 * 60;
const PENDING_ROUTE_PREFIX = 'discord:pending_route:';
// Discord supports at most five action rows. Reserve one for All repositories
// and one for Nevermind so every stored option is also visible and actionable.
const MAX_ENVIRONMENT_OPTIONS = 3;

type PendingRouteOption = {
  label: string;
  workspace: RoutingWorkspace;
};

type PendingDiscordRoute = {
  requesterDiscordUserId: string;
  launchOwnerUserId: string;
  queuedMessage: QueuedCommunicationMessage;
  metadata: DiscordEventCommunicationMetadata;
  channel: DiscordChannelContext;
  /**
   * The task thread the card was posted into, when the request could anchor
   * one. Replies and the requester check follow the card; the launch keeps
   * using `channel`, so it still resolves the same thread parent.
   */
  cardChannel?: DiscordChannelContext;
  options: PendingRouteOption[];
  forceNewThread?: boolean;
};

function pendingRouteKey(id: string): string {
  return `${PENDING_ROUTE_PREFIX}${id}`;
}

function parsePendingRoute(value: string | null): PendingDiscordRoute | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as PendingDiscordRoute;
  } catch {
    return null;
  }
}

async function storePendingRoute(
  id: string,
  pending: PendingDiscordRoute,
): Promise<void> {
  await getRedis().set(
    pendingRouteKey(id),
    JSON.stringify(pending),
    'EX',
    PENDING_ROUTE_TTL_SECONDS,
  );
}

async function claimPendingRoute(
  id: string,
): Promise<PendingDiscordRoute | null> {
  return parsePendingRoute(await getRedis().getdel(pendingRouteKey(id)));
}

async function restorePendingRoute(
  id: string,
  pending: PendingDiscordRoute,
): Promise<void> {
  await storePendingRoute(id, pending);
}

function optionLabel(value: string): string {
  const chars = Array.from(value);
  return chars.length > 70 ? `${chars.slice(0, 69).join('')}…` : value;
}

async function buildOptions(
  suggested: RoutingWorkspace | null,
): Promise<PendingRouteOption[]> {
  const environments = await getAvailableEnvironments();
  const suggestedId =
    suggested?.type === 'environment' ? suggested.id : undefined;
  const environmentOptions = environments
    .sort((left, right) =>
      left.id === suggestedId
        ? -1
        : right.id === suggestedId
          ? 1
          : left.name.localeCompare(right.name),
    )
    .slice(0, MAX_ENVIRONMENT_OPTIONS)
    .map((environment) => ({
      label: optionLabel(environment.name),
      workspace: {
        type: 'environment' as const,
        id: environment.id,
        name: environment.name,
      },
    }));
  const allRepositories: PendingRouteOption = {
    label: 'All repositories',
    workspace: { type: 'all_repositories' },
  };
  return suggested?.type === 'all_repositories'
    ? [allRepositories, ...environmentOptions]
    : [...environmentOptions, allRepositories];
}

function routeButtons(id: string, options: PendingRouteOption[]) {
  return [
    ...options.map((option, index) => [
      {
        text: option.label,
        callbackData: `discord:route:${id}:${index}`,
      },
    ]),
    [{ text: 'Nevermind', callbackData: `discord:route:${id}:cancel` }],
  ];
}

function taskThreadChannelContext(input: {
  channel: DiscordChannelContext;
  thread: DiscordTaskThread;
}): DiscordChannelContext {
  return {
    channelId: input.thread.channelId,
    channelName: input.thread.name,
    channelType:
      input.channel.channelType === DISCORD_CHANNEL_TYPE_ANNOUNCEMENT
        ? DISCORD_CHANNEL_TYPE_ANNOUNCEMENT_THREAD
        : DISCORD_CHANNEL_TYPE_PUBLIC_THREAD,
    ...(input.channel.guildId ? { guildId: input.channel.guildId } : {}),
    parentChannelId: input.thread.parentChannelId,
    isDirectMessage: false,
    isThread: true,
  };
}

export function shouldAutoConfirmDiscordRoute(
  decision: RoutingDecision,
): boolean {
  return (
    decision.status === 'routed' &&
    decision.result.debug?.workspaceRemapped !== true &&
    (decision.result.debug?.confidence ?? 0) >=
      DISCORD_IMMEDIATE_CONFIRM_CONFIDENCE
  );
}

export async function requestDiscordRoutingConfirmation(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  requesterDiscordUserId: string;
  launchOwnerUserId: string;
  queuedMessage: QueuedCommunicationMessage;
  metadata: DiscordEventCommunicationMetadata;
  channel: DiscordChannelContext;
  routingDecision: RoutingDecision;
  forceNewThread?: boolean;
}): Promise<{ pendingRouteId: string }> {
  const pendingRouteId = randomBytes(9).toString('base64url');
  const options = await buildOptions(
    input.routingDecision.status === 'routed'
      ? input.routingDecision.result.workspace
      : null,
  );
  // Slack asks this question inside the thread on the requesting message, so
  // the channel only ever shows the request itself. Start that thread now and
  // put the card in it; the launch reuses this exact thread. An interaction
  // answers through its own response, which always lands where it was invoked,
  // so those keep the card in the channel.
  const thread = input.interaction
    ? null
    : await reserveDiscordAnchoredThread({
        provider: input.provider,
        queuedMessage: input.queuedMessage,
        metadata: input.metadata,
        channel: input.channel,
        ...(input.forceNewThread ? { forceNewThread: true } : {}),
      }).catch((error) => {
        // Asking in the channel still routes the task; the launch retries the
        // thread. Failing the whole request over card placement would not.
        console.warn(
          `[discord] Failed to reserve task thread for event ${input.queuedMessage.ts}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
  const cardChannel = thread
    ? taskThreadChannelContext({ channel: input.channel, thread })
    : null;
  await storePendingRoute(pendingRouteId, {
    requesterDiscordUserId: input.requesterDiscordUserId,
    launchOwnerUserId: input.launchOwnerUserId,
    queuedMessage: input.queuedMessage,
    metadata: input.metadata,
    channel: input.channel,
    ...(cardChannel ? { cardChannel } : {}),
    options,
    ...(input.forceNewThread ? { forceNewThread: true } : {}),
  });
  const suggested = options[0]?.label;
  await replyToDiscordEvent({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: cardChannel ?? input.channel,
    ...(input.interaction ? { interaction: input.interaction } : {}),
    text: suggested
      ? `Where should I run this? The best match is **${suggested}**.`
      : 'Where should I run this?',
    buttons: routeButtons(pendingRouteId, options),
  });
  return { pendingRouteId };
}

export function parseDiscordRouteCallbackData(
  value: string | undefined,
): { pendingRouteId: string; selection: number | 'cancel' } | null {
  const match = /^discord:route:([A-Za-z0-9_-]{12}):(cancel|\d+)$/u.exec(
    value ?? '',
  );
  if (!match) return null;
  return {
    pendingRouteId: match[1]!,
    selection:
      match[2] === 'cancel' ? 'cancel' : Number.parseInt(match[2]!, 10),
  };
}

export async function handleDiscordRoutingCallback(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  interaction: DiscordInteraction;
  interactionDeferred: boolean;
  callback: { pendingRouteId: string; selection: number | 'cancel' };
}): Promise<void> {
  const pending = await claimPendingRoute(input.callback.pendingRouteId);
  const interactionUser =
    input.interaction.member?.user ?? input.interaction.user;
  const fallbackChannel: DiscordChannelContext = {
    channelId: input.interaction.channel_id ?? 'unknown',
    channelName: 'Discord',
    channelType: input.interaction.channel?.type ?? 0,
    ...(input.interaction.guild_id
      ? { guildId: input.interaction.guild_id }
      : {}),
    isDirectMessage: !input.interaction.guild_id,
    isThread: false,
  };
  if (!pending) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: fallbackChannel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text: 'That routing choice is no longer available.',
    });
    return;
  }
  // The card may live in the task thread rather than the channel it came from.
  const replyChannel = pending.cardChannel ?? pending.channel;
  const mappedUserId = await findDiscordMappedUserId(interactionUser?.id);
  if (
    !interactionUser ||
    interactionUser.id !== pending.requesterDiscordUserId ||
    mappedUserId !== pending.launchOwnerUserId ||
    input.interaction.channel_id !== replyChannel.channelId
  ) {
    await restorePendingRoute(input.callback.pendingRouteId, pending);
    await input.provider.postMessage({
      channelId: replyChannel.parentChannelId ?? replyChannel.channelId,
      ...(replyChannel.parentChannelId
        ? { threadId: replyChannel.channelId }
        : {}),
      text: 'Only the person who started this request can choose its workspace.',
    });
    return;
  }
  if (input.callback.selection === 'cancel') {
    // The reserved thread keeps the canceled card, exactly as a canceled Slack
    // request leaves its thread behind, but nothing should launch into it.
    await forgetPendingTaskThread(pending.queuedMessage.ts).catch(
      () => undefined,
    );
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: replyChannel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text: 'Canceled the request.',
    });
    return;
  }
  const option = pending.options[input.callback.selection];
  if (!option) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: replyChannel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text: 'That workspace is no longer available. Send the request again.',
    });
    return;
  }
  let existingRun: Awaited<
    ReturnType<typeof findCommunicationTaskRunBySourceEvent>
  >;
  try {
    existingRun = await findCommunicationTaskRunBySourceEvent({
      provider: 'discord',
      sourceEventId: pending.queuedMessage.ts,
    });
  } catch (error) {
    await restorePendingRoute(input.callback.pendingRouteId, pending).catch(
      () => undefined,
    );
    throw error;
  }
  if (existingRun) {
    const taskUrl = getTaskUrl({
      taskId: existingRun.taskId,
      utm: { source: 'discord', campaign: 'discord.route_retry' },
    });
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: replyChannel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text: taskUrl
        ? `This request already started a task: ${taskUrl}`
        : 'This request already started a task.',
    }).catch(() => undefined);
    return;
  }
  let workspace: Awaited<ReturnType<typeof resolveDiscordWorkspace>>;
  try {
    workspace = await resolveDiscordWorkspace(option.workspace);
  } catch (error) {
    await restorePendingRoute(input.callback.pendingRouteId, pending).catch(
      () => undefined,
    );
    throw error;
  }
  if (!workspace) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: replyChannel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text: 'That workspace is no longer available. Send the request again.',
    });
    return;
  }
  let launched: Awaited<ReturnType<typeof launchDiscordTask>>;
  try {
    launched = await launchDiscordTask({
      provider: input.provider,
      launchOwnerUserId: pending.launchOwnerUserId,
      queuedMessage: pending.queuedMessage,
      metadata: pending.metadata,
      channel: pending.channel,
      workspace,
      forceNewThread: pending.forceNewThread,
      // A card already in the task thread is where the acknowledgement was
      // going anyway, so the launch turns it into one instead of posting an
      // identical message beneath it.
      ...(pending.cardChannel
        ? {
            replaceMessage: {
              applicationId: input.applicationId,
              interaction: input.interaction,
              interactionDeferred: input.interactionDeferred,
              channel: pending.cardChannel,
            },
          }
        : {}),
    });
  } catch (error) {
    await restorePendingRoute(input.callback.pendingRouteId, pending).catch(
      () => undefined,
    );
    throw error;
  }
  // The launch already answered a card that lived in the task thread.
  if (pending.cardChannel) return;
  await replyToDiscordEvent({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: replyChannel,
    interaction: {
      interaction: input.interaction,
      interactionDeferred: input.interactionDeferred,
    },
    // Away from the thread the card stays a routing receipt, pointing at the
    // thread that carries the real acknowledgement.
    text: launched.createdThread
      ? `Started in **${workspace.workspaceDisplayName}**. Continue in the new task thread.`
      : `Started in **${workspace.workspaceDisplayName}**.`,
    ...(launched.taskUrl
      ? { buttons: [[{ text: 'Follow Task', url: launched.taskUrl }]] }
      : {}),
  }).catch(() => undefined);
}

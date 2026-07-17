import { randomBytes } from 'node:crypto';

import {
  getAvailableEnvironments,
  getRoutingAutoConfirmDelayMs,
  getTaskUrl,
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS,
  type RoutingDecision,
  type RoutingContext,
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
import { apiLogger } from '../../logging.js';
import { findCommunicationTaskRunBySourceEvent } from '../tasks/communication-task-run-lookup.js';
import { resolveRoutingFollowUp } from '../tasks/routing-follow-up.js';
import { replyToDiscordEvent } from './replies.js';
import {
  forgetPendingTaskThread,
  launchDiscordTask,
  reserveDiscordAnchoredThread,
  resolveDiscordWorkspace,
  type DiscordChannelContext,
} from './task-launch.js';

const DISCORD_CHANNEL_TYPE_ANNOUNCEMENT = 5;
const DISCORD_CHANNEL_TYPE_ANNOUNCEMENT_THREAD = 10;
const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;
const PENDING_ROUTE_TTL_SECONDS = 15 * 60;
const PENDING_ROUTE_PREFIX = 'discord:pending_route:';
const PENDING_ROUTE_CHANNEL_POINTER_PREFIX =
  'discord:pending_route_channel_ptr:';
const PENDING_ROUTE_CARD_POINTER_PREFIX = 'discord:pending_route_card_ptr:';
// Discord supports at most five action rows. Reserve one for All repositories
// and one for Never mind so every stored option is also visible and actionable.
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
  routingContext?: RoutingContext;
  channel: DiscordChannelContext;
  /**
   * The task thread the card was posted into, when the request could anchor
   * one. Replies and the requester check follow the card; the launch keeps
   * using `channel`, so it still resolves the same thread parent.
   */
  cardChannel?: DiscordChannelContext;
  /** The card itself, so an auto-confirm can turn it into the acknowledgement. */
  cardMessageId?: string;
  options: PendingRouteOption[];
  /**
   * Which option the router actually suggested, or null when it had no opinion
   * and the card is a plain menu. Only a suggestion may be auto-confirmed.
   */
  suggestedIndex: number | null;
  forceNewThread?: boolean;
};

function pendingRouteKey(id: string): string {
  return `${PENDING_ROUTE_PREFIX}${id}`;
}

function pendingRouteChannelPointerKey(channelId: string): string {
  return `${PENDING_ROUTE_CHANNEL_POINTER_PREFIX}${channelId}`;
}

function pendingRouteCardPointerKey(messageId: string): string {
  return `${PENDING_ROUTE_CARD_POINTER_PREFIX}${messageId}`;
}

function replyChannel(pending: PendingDiscordRoute): DiscordChannelContext {
  return pending.cardChannel ?? pending.channel;
}

function safeConversationPointerChannelId(
  pending: PendingDiscordRoute,
): string | null {
  if (pending.cardChannel) return pending.cardChannel.channelId;
  return pending.channel.isDirectMessage ? pending.channel.channelId : null;
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
  options?: { onlyIfExists?: boolean },
): Promise<void> {
  const key = pendingRouteKey(id);
  const value = JSON.stringify(pending);
  if (options?.onlyIfExists) {
    // XX so a click that already claimed the route is not resurrected by a
    // later write — otherwise the timer would launch a canceled request.
    await getRedis().set(key, value, 'EX', PENDING_ROUTE_TTL_SECONDS, 'XX');
    return;
  }
  await getRedis().set(key, value, 'EX', PENDING_ROUTE_TTL_SECONDS);
}

async function claimPendingRoute(
  id: string,
): Promise<PendingDiscordRoute | null> {
  const redis = getRedis();
  const pending = parsePendingRoute(await redis.getdel(pendingRouteKey(id)));
  if (!pending) return null;

  const channelId = safeConversationPointerChannelId(pending);
  if (
    channelId &&
    (await redis.get(pendingRouteChannelPointerKey(channelId))) === id
  ) {
    await redis.del(pendingRouteChannelPointerKey(channelId));
  }
  if (
    pending.cardMessageId &&
    (await redis.get(pendingRouteCardPointerKey(pending.cardMessageId))) === id
  ) {
    await redis.del(pendingRouteCardPointerKey(pending.cardMessageId));
  }

  return pending;
}

async function storePendingRoutePointers(
  id: string,
  pending: PendingDiscordRoute,
): Promise<void> {
  const redis = getRedis();
  const channelId = safeConversationPointerChannelId(pending);
  if (channelId) {
    await redis.set(
      pendingRouteChannelPointerKey(channelId),
      id,
      'EX',
      PENDING_ROUTE_TTL_SECONDS,
    );
  }
  if (pending.cardMessageId) {
    await redis.set(
      pendingRouteCardPointerKey(pending.cardMessageId),
      id,
      'EX',
      PENDING_ROUTE_TTL_SECONDS,
    );
  }
}

async function restorePendingRoute(
  id: string,
  pending: PendingDiscordRoute,
): Promise<void> {
  await storePendingRoutePointers(id, pending);
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

function sameWorkspace(
  left: RoutingWorkspace,
  right: RoutingWorkspace,
): boolean {
  return left.type === 'environment' && right.type === 'environment'
    ? left.id === right.id
    : left.type === right.type;
}

/**
 * The router's pick, located in the rendered options. A suggestion the router
 * named can vanish before the card is built, so this never assumes it is the
 * first option.
 */
function findSuggestedIndex(
  options: PendingRouteOption[],
  suggested: RoutingWorkspace | null,
): number | null {
  if (!suggested) return null;
  const index = options.findIndex((option) =>
    sameWorkspace(option.workspace, suggested),
  );
  return index < 0 ? null : index;
}

function routeButtons(id: string, options: PendingRouteOption[]) {
  return [
    ...options.map((option, index) => [
      {
        text: option.label,
        callbackData: `discord:route:${id}:${index}`,
      },
    ]),
    [{ text: 'Never mind', callbackData: `discord:route:${id}:cancel` }],
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

/**
 * Launches the option the router suggested when nobody answers the card, so a
 * request cannot die of inattention. Slack and Telegram both do this; without
 * it a Discord card just expires with its TTL and the request is silently lost.
 */
async function autoConfirmDiscordRouting(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  pendingRouteId: string;
}): Promise<void> {
  // Claiming is atomic, so a click landing at the same moment wins one of the
  // two paths and the other finds nothing.
  const pending = await claimPendingRoute(input.pendingRouteId);
  if (!pending || pending.suggestedIndex === null) return;
  const option = pending.options[pending.suggestedIndex];
  if (!option) return;
  try {
    const existingRun = await findCommunicationTaskRunBySourceEvent({
      provider: 'discord',
      sourceEventId: pending.queuedMessage.ts,
    });
    if (existingRun) return;
    const workspace = await resolveDiscordWorkspace(option.workspace);
    if (!workspace) {
      await input.provider
        .postMessage({
          channelId:
            pending.cardChannel?.parentChannelId ?? pending.channel.channelId,
          ...(pending.cardChannel
            ? { threadId: pending.cardChannel.channelId }
            : {}),
          text: 'Could not start the task — the suggested workspace is no longer available. Send the request again.',
        })
        .catch(() => undefined);
      return;
    }
    const launched = await launchDiscordTask({
      provider: input.provider,
      launchOwnerUserId: pending.launchOwnerUserId,
      queuedMessage: pending.queuedMessage,
      metadata: pending.metadata,
      channel: pending.channel,
      workspace,
      ...(pending.forceNewThread ? { forceNewThread: true } : {}),
      // No interaction here — nobody clicked. A card that already lives in
      // the task thread becomes the launch acknowledgement itself.
      ...(pending.cardChannel && pending.cardMessageId
        ? {
            replaceMessage: {
              channel: pending.cardChannel,
              messageId: pending.cardMessageId,
            },
          }
        : {}),
    });

    if (!pending.cardChannel && pending.cardMessageId) {
      // DMs, interaction cards, and thread-reservation fallbacks keep their
      // routing card outside the task conversation. The launch has already
      // posted its acknowledgement and controls in the right destination;
      // turn the original card into a terminal receipt so stale route buttons
      // do not remain visible.
      await input.provider
        .editMessage({
          channelId: pending.channel.channelId,
          messageId: pending.cardMessageId,
          text: launched.createdThread
            ? `Started in **${workspace.workspaceDisplayName}**. Continue in the new task thread.`
            : `Started in **${workspace.workspaceDisplayName}**.`,
          buttons: launched.taskUrl
            ? [[{ text: 'Follow Task', url: launched.taskUrl }]]
            : [],
        })
        .catch((error) => {
          apiLogger.warn(
            `[discord] Could not finalize routing card ${pending.cardMessageId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
  } catch (error) {
    // The click path restores its claim when lookup, workspace resolution, or
    // launch fails. Auto-confirm must do the same so a transient failure does
    // not consume the route and leave its buttons permanently dead.
    await restorePendingRoute(input.pendingRouteId, pending).catch(
      (restoreError) => {
        apiLogger.warn(
          `[discord] Could not restore routing choice ${input.pendingRouteId}: ${
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError)
          }`,
        );
      },
    );
    throw error;
  }
}

function scheduleDiscordRoutingAutoConfirm(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  pendingRouteId: string;
}): void {
  const timer = setTimeout(() => {
    autoConfirmDiscordRouting(input).catch((error) => {
      apiLogger.warn(
        `[discord] Routing auto-confirm failed for ${input.pendingRouteId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, ROUTING_AUTO_CONFIRM_TIMEOUT_MS);

  // Like Slack's and Telegram's, the timer is in-process: a restart loses it
  // and the pending route simply expires with its Redis TTL.
  timer.unref?.();
}

export function shouldAutoConfirmDiscordRoute(
  decision: RoutingDecision,
): boolean {
  return (
    decision.status === 'routed' &&
    getRoutingAutoConfirmDelayMs(
      decision.result.debug,
      decision.result.workspace.type,
    ) === 0
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
  routingContext?: RoutingContext;
  channel: DiscordChannelContext;
  routingDecision: RoutingDecision;
  forceNewThread?: boolean;
}): Promise<{ pendingRouteId: string }> {
  const pendingRouteId = randomBytes(9).toString('base64url');
  const suggestedWorkspace =
    input.routingDecision.status === 'routed'
      ? input.routingDecision.result.workspace
      : null;
  const options = await buildOptions(suggestedWorkspace);
  const suggestedIndex = findSuggestedIndex(options, suggestedWorkspace);
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
  const pending: PendingDiscordRoute = {
    requesterDiscordUserId: input.requesterDiscordUserId,
    launchOwnerUserId: input.launchOwnerUserId,
    queuedMessage: input.queuedMessage,
    metadata: input.metadata,
    ...(input.routingContext ? { routingContext: input.routingContext } : {}),
    channel: input.channel,
    ...(cardChannel ? { cardChannel } : {}),
    options,
    suggestedIndex,
    ...(input.forceNewThread ? { forceNewThread: true } : {}),
  };
  await storePendingRoute(pendingRouteId, pending);
  // Only name a best match when the router actually picked one. Without a
  // suggestion the card is a plain menu, and nothing gets auto-confirmed.
  const suggested =
    suggestedIndex === null ? undefined : options[suggestedIndex]?.label;
  const card = await replyToDiscordEvent({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: cardChannel ?? input.channel,
    ...(input.interaction ? { interaction: input.interaction } : {}),
    text: suggested
      ? `Where should I run this? The best match is **${suggested}** — starting in ~${Math.round(ROUTING_AUTO_CONFIRM_TIMEOUT_MS / 1_000)}s.`
      : 'Where should I run this?',
    buttons: routeButtons(pendingRouteId, options),
  });
  // Re-store so the timer can turn the card itself into the acknowledgement.
  // The route is stored before the card is posted so a fast click cannot miss
  // it, which leaves the card id as the one thing learned afterwards.
  const pendingWithCard = {
    ...pending,
    ...(card.messageId ? { cardMessageId: card.messageId } : {}),
  };
  await storePendingRoutePointers(pendingRouteId, pendingWithCard);
  await storePendingRoute(
    pendingRouteId,
    pendingWithCard,
    // A click can land while the card post is still completing and claim the
    // route. This write must not bring it back from the dead.
    { onlyIfExists: true },
  );
  if (suggestedIndex === null) {
    return { pendingRouteId };
  }
  scheduleDiscordRoutingAutoConfirm({
    provider: input.provider,
    applicationId: input.applicationId,
    pendingRouteId,
  });
  return { pendingRouteId };
}

/** Locate a pending card that a normal Discord message can safely answer. */
export async function findDiscordPendingRoutingReply(input: {
  channel: DiscordChannelContext;
  replyToMessageId?: string;
  requesterDiscordUserId: string;
  launchOwnerUserId: string;
}): Promise<{ pendingRouteId: string } | null> {
  const redis = getRedis();
  const candidateIds: string[] = [];

  if (input.replyToMessageId) {
    const cardRouteId = await redis.get(
      pendingRouteCardPointerKey(input.replyToMessageId),
    );
    if (cardRouteId) candidateIds.push(cardRouteId);
  }

  if (input.channel.isDirectMessage || input.channel.isThread) {
    const channelRouteId = await redis.get(
      pendingRouteChannelPointerKey(input.channel.channelId),
    );
    if (channelRouteId && !candidateIds.includes(channelRouteId)) {
      candidateIds.push(channelRouteId);
    }
  }

  for (const pendingRouteId of candidateIds) {
    const pending = parsePendingRoute(
      await redis.get(pendingRouteKey(pendingRouteId)),
    );
    if (
      pending?.routingContext &&
      pending.requesterDiscordUserId === input.requesterDiscordUserId &&
      pending.launchOwnerUserId === input.launchOwnerUserId &&
      replyChannel(pending).channelId === input.channel.channelId
    ) {
      return { pendingRouteId };
    }
  }

  return null;
}

async function editPendingDiscordCard(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  pending: PendingDiscordRoute;
  text: string;
  buttons?: ReturnType<typeof routeButtons>;
}): Promise<string | undefined> {
  const channel = replyChannel(input.pending);
  if (input.pending.cardMessageId) {
    try {
      await input.provider.editMessage({
        channelId: channel.channelId,
        messageId: input.pending.cardMessageId,
        text: input.text,
        buttons: input.buttons ?? [],
      });
      return input.pending.cardMessageId;
    } catch (error) {
      apiLogger.warn(
        `[discord] Could not update routing card ${input.pending.cardMessageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const posted = await replyToDiscordEvent({
    provider: input.provider,
    applicationId: input.applicationId,
    channel,
    text: input.text,
    ...(input.buttons ? { buttons: input.buttons } : {}),
  });
  return posted.messageId;
}

async function launchPendingDiscordRoute(input: {
  provider: DiscordCommunicationProvider;
  pending: PendingDiscordRoute;
  option: PendingRouteOption;
}): Promise<void> {
  const existingRun = await findCommunicationTaskRunBySourceEvent({
    provider: 'discord',
    sourceEventId: input.pending.queuedMessage.ts,
  });
  if (existingRun) return;

  const workspace = await resolveDiscordWorkspace(input.option.workspace);
  if (!workspace) {
    throw new Error('The selected Discord workspace is no longer available.');
  }

  const launched = await launchDiscordTask({
    provider: input.provider,
    launchOwnerUserId: input.pending.launchOwnerUserId,
    queuedMessage: input.pending.queuedMessage,
    metadata: input.pending.metadata,
    channel: input.pending.channel,
    workspace,
    ...(input.pending.forceNewThread ? { forceNewThread: true } : {}),
    ...(input.pending.cardChannel && input.pending.cardMessageId
      ? {
          replaceMessage: {
            channel: input.pending.cardChannel,
            messageId: input.pending.cardMessageId,
          },
        }
      : {}),
  });

  if (!input.pending.cardChannel && input.pending.cardMessageId) {
    await input.provider.editMessage({
      channelId: input.pending.channel.channelId,
      messageId: input.pending.cardMessageId,
      text: launched.createdThread
        ? `Started in **${workspace.workspaceDisplayName}**. Continue in the new task thread.`
        : `Started in **${workspace.workspaceDisplayName}**.`,
      buttons: launched.taskUrl
        ? [[{ text: 'Follow Task', url: launched.taskUrl }]]
        : [],
    });
  }
}

/** Handle a free-text response to a pending Discord routing card. */
export async function handleDiscordRoutingReply(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  pendingRouteId: string;
  requesterDiscordUserId: string;
  launchOwnerUserId: string;
  queuedMessage: QueuedCommunicationMessage;
  channel: DiscordChannelContext;
}): Promise<boolean> {
  const pending = await claimPendingRoute(input.pendingRouteId);
  if (
    !pending?.routingContext ||
    pending.requesterDiscordUserId !== input.requesterDiscordUserId ||
    pending.launchOwnerUserId !== input.launchOwnerUserId ||
    replyChannel(pending).channelId !== input.channel.channelId
  ) {
    if (pending) {
      await restorePendingRoute(input.pendingRouteId, pending);
    }
    return false;
  }

  const suggestedOption =
    pending.suggestedIndex === null
      ? null
      : (pending.options[pending.suggestedIndex] ?? null);
  let replacementRouteId: string | null = null;

  try {
    const resolution = await resolveRoutingFollowUp({
      routingContext: pending.routingContext,
      suggestion: suggestedOption
        ? {
            workspace: suggestedOption.workspace,
            workspaceDisplayName: suggestedOption.label,
          }
        : null,
      userResponse: input.queuedMessage.text,
      userName: input.queuedMessage.user,
      userId: input.launchOwnerUserId,
    });

    if (resolution.intent === 'cancel') {
      await forgetPendingTaskThread(pending.queuedMessage.ts).catch(
        () => undefined,
      );
      await editPendingDiscordCard({
        provider: input.provider,
        applicationId: input.applicationId,
        pending,
        text: 'Canceled the request.',
      });
      return true;
    }

    if (resolution.intent === 'confirm') {
      if (!suggestedOption) {
        throw new Error('A Discord routing confirmation had no suggestion.');
      }
      await launchPendingDiscordRoute({
        provider: input.provider,
        pending,
        option: suggestedOption,
      });
      return true;
    }

    const routingDecision = resolution.routingDecision;
    if (routingDecision.status === 'platform_answer') {
      await editPendingDiscordCard({
        provider: input.provider,
        applicationId: input.applicationId,
        pending,
        text: routingDecision.result.answer,
      });
      return true;
    }

    const routed =
      routingDecision.status === 'routed' ? routingDecision.result : null;
    const options = await buildOptions(routed?.workspace ?? null);
    const suggestedIndex = findSuggestedIndex(
      options,
      routed?.workspace ?? null,
    );
    const autoConfirmDelayMs = routed
      ? getRoutingAutoConfirmDelayMs(routed.debug, routed.workspace.type)
      : null;
    const nextSuggestedOption =
      suggestedIndex === null ? null : (options[suggestedIndex] ?? null);
    const nextPending: PendingDiscordRoute = {
      ...pending,
      options,
      suggestedIndex,
    };

    if (nextSuggestedOption && autoConfirmDelayMs === 0) {
      await launchPendingDiscordRoute({
        provider: input.provider,
        pending: nextPending,
        option: nextSuggestedOption,
      });
      return true;
    }

    replacementRouteId = randomBytes(9).toString('base64url');
    const text = nextSuggestedOption
      ? `Where should I run this? The best match is **${nextSuggestedOption.label}** — starting in ~${Math.round((autoConfirmDelayMs ?? ROUTING_AUTO_CONFIRM_TIMEOUT_MS) / 1_000)}s.`
      : 'Where should I run this?';
    const buttons = routeButtons(replacementRouteId, options);
    await storePendingRoute(replacementRouteId, nextPending);
    await storePendingRoutePointers(replacementRouteId, nextPending);
    const cardMessageId = await editPendingDiscordCard({
      provider: input.provider,
      applicationId: input.applicationId,
      pending: nextPending,
      text,
      buttons,
    });
    if (cardMessageId && cardMessageId !== nextPending.cardMessageId) {
      nextPending.cardMessageId = cardMessageId;
      await storePendingRoute(replacementRouteId, nextPending, {
        onlyIfExists: true,
      });
      await storePendingRoutePointers(replacementRouteId, nextPending);
    }

    if (nextSuggestedOption && autoConfirmDelayMs !== null) {
      scheduleDiscordRoutingAutoConfirm({
        provider: input.provider,
        applicationId: input.applicationId,
        pendingRouteId: replacementRouteId,
      });
    }
    return true;
  } catch (error) {
    if (replacementRouteId) {
      await claimPendingRoute(replacementRouteId).catch(() => undefined);
    }
    await restorePendingRoute(input.pendingRouteId, pending).catch(
      () => undefined,
    );
    throw error;
  }
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
              channel: pending.cardChannel,
              interaction: {
                applicationId: input.applicationId,
                interaction: input.interaction,
                interactionDeferred: input.interactionDeferred,
              },
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

import { Env } from '@roomote/env';
import {
  buildDiscordRoutingContext,
  getTaskUrl,
  routeTask,
} from '@roomote/cloud-agents/server';
import type { DiscordInteraction } from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { findDiscordInstallationByGuildId } from '@roomote/sdk/server';
import {
  ALL_REPOSITORIES,
  type QueuedCommunicationMessage,
} from '@roomote/types';

import type { DiscordEventCommunicationMetadata } from '@roomote/communication/discord-event';
import { findCommunicationTaskRunBySourceEvent } from '../tasks/communication-task-run-lookup.js';
import { replyToDiscordEvent } from './replies.js';
import {
  requestDiscordRoutingConfirmation,
  shouldAutoConfirmDiscordRoute,
} from './routing-confirmation.js';
import {
  launchDiscordTask,
  resolveDiscordWorkspace,
  type DiscordChannelContext,
} from './task-launch.js';

async function fetchThreadHistoryBestEffort(input: {
  provider: DiscordCommunicationProvider;
  channelId: string;
}): Promise<Array<{ user: string; text: string }>> {
  try {
    const result = await input.provider.fetchChannelMessages({
      channelId: input.channelId,
    });
    return result.messages
      .filter((message) => message.text.trim())
      .slice(-5)
      .map((message) => ({
        user: message.username ?? message.user,
        text: message.text,
      }));
  } catch {
    return [];
  }
}

export async function startNewDiscordTask(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  requesterDiscordUserId: string;
  launchOwnerUserId: string;
  queuedMessage: QueuedCommunicationMessage;
  metadata: DiscordEventCommunicationMetadata;
  channel: DiscordChannelContext;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  skipRoutingConfirmation?: boolean;
  forceNewThread?: boolean;
}) {
  const existingRun = await findCommunicationTaskRunBySourceEvent({
    provider: 'discord',
    sourceEventId: input.queuedMessage.ts,
  });
  if (existingRun) {
    const taskUrl = getTaskUrl({
      taskId: existingRun.taskId,
      utm: { source: 'discord', campaign: 'discord.idempotent_retry' },
    });
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      ...(input.interaction ? { interaction: input.interaction } : {}),
      text: taskUrl
        ? `This request already started a task: ${taskUrl}`
        : 'This request already started a task.',
    }).catch(() => undefined);
    return {
      status: 'already_started' as const,
      existingRun,
      taskUrl,
    };
  }

  const [history, installation] = await Promise.all([
    fetchThreadHistoryBestEffort({
      provider: input.provider,
      channelId: input.channel.channelId,
    }),
    input.channel.guildId
      ? findDiscordInstallationByGuildId(input.channel.guildId)
      : Promise.resolve(null),
  ]);
  const triggeringMessage = {
    user: input.queuedMessage.user,
    text: input.queuedMessage.text,
  };
  const threadMessages = history.some(
    (message) =>
      message.user === triggeringMessage.user &&
      message.text === triggeringMessage.text,
  )
    ? history
    : [...history, triggeringMessage].slice(-5);
  const routingContext = await buildDiscordRoutingContext({
    userId: input.launchOwnerUserId,
    taskDescription: input.queuedMessage.text,
    guildName: installation?.guildName ?? undefined,
    channelName: input.channel.channelName,
    threadMessages,
    ...(input.queuedMessage.images?.length
      ? { images: input.queuedMessage.images }
      : {}),
    apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
  });
  const routingDecision = await routeTask(routingContext);
  if (routingDecision.status === 'platform_answer') {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      ...(input.interaction ? { interaction: input.interaction } : {}),
      text: routingDecision.result.answer,
    });
    return { status: 'replied_inline' as const, routingDecision };
  }

  if (
    !input.skipRoutingConfirmation &&
    !shouldAutoConfirmDiscordRoute(routingDecision)
  ) {
    const confirmation = await requestDiscordRoutingConfirmation({
      provider: input.provider,
      applicationId: input.applicationId,
      ...(input.interaction ? { interaction: input.interaction } : {}),
      requesterDiscordUserId: input.requesterDiscordUserId,
      launchOwnerUserId: input.launchOwnerUserId,
      queuedMessage: input.queuedMessage,
      metadata: input.metadata,
      channel: input.channel,
      routingDecision,
      forceNewThread: input.forceNewThread,
    });
    return {
      status: 'confirmation_pending' as const,
      routingDecision,
      pendingRouteId: confirmation.pendingRouteId,
    };
  }

  const workspace =
    routingDecision.status === 'routed'
      ? await resolveDiscordWorkspace(routingDecision.result.workspace)
      : {
          repoForPayload: ALL_REPOSITORIES,
          workspaceDisplayName: 'all repos',
        };
  if (!workspace) {
    throw new Error('Discord task routing selected an unavailable workspace.');
  }
  const launched = await launchDiscordTask({
    provider: input.provider,
    launchOwnerUserId: input.launchOwnerUserId,
    queuedMessage: input.queuedMessage,
    metadata: input.metadata,
    channel: input.channel,
    workspace,
    forceNewThread: input.forceNewThread,
  });
  if (input.interaction) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      interaction: input.interaction,
      text: launched.createdThread
        ? `Started in **${workspace.workspaceDisplayName}**. Continue in the new task thread.`
        : `Started in **${workspace.workspaceDisplayName}**.`,
      ...(launched.taskUrl
        ? { buttons: [[{ text: 'Follow Task', url: launched.taskUrl }]] }
        : {}),
    });
  }
  return {
    status: 'started' as const,
    routingDecision,
    workspace,
    ...launched,
  };
}

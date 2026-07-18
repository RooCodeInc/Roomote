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
  type TaskInitiator,
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
  /** Absent only for automation-owned channel auto-start launches. */
  launchOwnerUserId?: string;
  queuedMessage: QueuedCommunicationMessage;
  metadata: DiscordEventCommunicationMetadata;
  channel: DiscordChannelContext;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  skipRoutingConfirmation?: boolean;
  /**
   * Set for configured auto-respond channel launches: the per-channel
   * instructions become the agent prompt prefix, the supplied initiator
   * carries attribution, and conversational fallbacks (platform answers,
   * duplicate-start replies) stay out of the monitored channel.
   */
  channelAutoStart?: {
    agentPromptPrefix?: string;
    initiator: TaskInitiator;
  };
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
    if (!input.channelAutoStart) {
      await replyToDiscordEvent({
        provider: input.provider,
        applicationId: input.applicationId,
        channel: input.channel,
        ...(input.interaction ? { interaction: input.interaction } : {}),
        text: taskUrl
          ? `This request already started a task: ${taskUrl}`
          : 'This request already started a task.',
      }).catch(() => undefined);
    }
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
    // Auto-respond channels must not turn Roomote into a channel chatbot:
    // a question-shaped message that routes to a platform answer is skipped
    // silently (mirrors Slack's auto-routed path, which never posts answers).
    if (input.channelAutoStart) {
      return { status: 'skipped_platform_answer' as const, routingDecision };
    }
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
    // Confirmation cards need a launch owner to accept on behalf of; the
    // ownerless case only arises on auto-start paths, which skip them anyway.
    input.launchOwnerUserId &&
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
      routingContext,
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
  const agentPromptPrefix = input.channelAutoStart?.agentPromptPrefix?.trim();
  const kickoffMessage =
    routingDecision.status === 'routed'
      ? routingDecision.result.kickoffMessage
      : undefined;
  const launched = await launchDiscordTask({
    provider: input.provider,
    launchOwnerUserId: input.launchOwnerUserId,
    ...(input.channelAutoStart
      ? { initiator: input.channelAutoStart.initiator }
      : {}),
    ...(agentPromptPrefix
      ? {
          agentPromptText: `${agentPromptPrefix}\n\n${input.queuedMessage.text}`,
        }
      : {}),
    queuedMessage: input.queuedMessage,
    metadata: input.metadata,
    channel: input.channel,
    workspace,
    forceNewThread: input.forceNewThread,
    ...(kickoffMessage ? { kickoffMessage } : {}),
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

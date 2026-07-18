import { Env } from '@roomote/env';
import { appendAttachmentTextsToPromptText } from '@roomote/cloud-agents';
import {
  buildDiscordRoutingContext,
  getTaskUrl,
  routeTask,
} from '@roomote/cloud-agents/server';
import type {
  DiscordAttachment,
  DiscordInteraction,
} from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { findDiscordInstallationByGuildId } from '@roomote/sdk/server';
import {
  ALL_REPOSITORIES,
  type QueuedCommunicationMessage,
  type TaskInitiator,
} from '@roomote/types';

import type { DiscordEventCommunicationMetadata } from '@roomote/communication/discord-event';
import { findCommunicationTaskRunBySourceEvent } from '../tasks/communication-task-run-lookup.js';
import { processDiscordAttachments } from './attachments.js';
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

type DiscordThreadHistoryMessage = {
  id: string;
  user: string;
  username?: string;
  text: string;
  botId?: string;
  attachments: DiscordAttachment[];
};

function escapeDiscordPromptContent(value: string): string {
  return value
    .replaceAll('&', '&' + 'amp;')
    .replaceAll('<', '&' + 'lt;')
    .replaceAll('>', '&' + 'gt;');
}

function compareDiscordSnowflakes(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
  } catch {
    return left.localeCompare(right);
  }
}

function formatDiscordThreadContext(input: {
  messages: DiscordThreadHistoryMessage[];
  currentMessageId: string;
}): string | undefined {
  const earlier = input.messages.filter(
    (message) =>
      compareDiscordSnowflakes(message.id, input.currentMessageId) < 0 &&
      message.text.trim().length > 0,
  );
  if (earlier.length === 0) return undefined;

  const entries = earlier.map((message) => {
    const displayName = (
      message.username?.trim() ||
      message.user ||
      'Unknown'
    ).trim();
    return `${escapeDiscordPromptContent(displayName)}: ${escapeDiscordPromptContent(message.text.trim())}`;
  });

  return `<thread_context>\n${entries.join('\n\n')}\n</thread_context>`;
}

function toDiscordAttachmentsFromHistory(
  messages: DiscordThreadHistoryMessage[],
  options?: { excludeMessageId?: string },
): DiscordAttachment[] {
  const attachments: DiscordAttachment[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (options?.excludeMessageId && message.id === options.excludeMessageId) {
      continue;
    }
    for (const attachment of message.attachments) {
      if (!attachment.url || seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      attachments.push(attachment);
    }
  }
  return attachments;
}

async function fetchThreadHistoryBestEffort(input: {
  provider: DiscordCommunicationProvider;
  channelId: string;
}): Promise<DiscordThreadHistoryMessage[]> {
  // Discord returns newest-first pages of up to 100. Walk backward with `before`
  // so a long thread still becomes agent context (Slack fetches full reply chains).
  const MAX_THREAD_HISTORY_MESSAGES = 500;
  const PAGE_SIZE = 100;
  try {
    const collected: DiscordThreadHistoryMessage[] = [];
    let before: string | undefined;
    while (collected.length < MAX_THREAD_HISTORY_MESSAGES) {
      const result = await input.provider.fetchChannelMessages({
        channelId: input.channelId,
        ...(before ? { latest: before } : {}),
      });
      if (result.messages.length === 0) break;

      const page = result.messages.map((message) => ({
        id: message.id,
        user: message.user,
        ...(message.username ? { username: message.username } : {}),
        text: message.text,
        ...(message.botId ? { botId: message.botId } : {}),
        attachments: (message.files ?? [])
          .filter((file) => Boolean(file.url?.trim()))
          .map((file) => ({
            id: file.id,
            filename: file.name,
            size: file.size,
            url: file.url!,
            ...(file.mimeType && file.mimeType !== 'application/octet-stream'
              ? { content_type: file.mimeType }
              : {}),
          })),
      }));

      // Pages arrive newest-last after provider reverse; prepend so overall
      // order stays oldest -> newest while we walk earlier pages.
      collected.unshift(...page);
      if (result.messages.length < PAGE_SIZE) break;
      before = page[0]?.id;
      if (!before) break;
    }

    if (collected.length > MAX_THREAD_HISTORY_MESSAGES) {
      return collected.slice(-MAX_THREAD_HISTORY_MESSAGES);
    }
    return collected;
  } catch (error) {
    console.warn(
      `[discord] Failed to fetch thread history for channel ${input.channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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

  // Full transcript + prior attachments belong on task start only when the
  // launch already lives inside a Discord thread and is not /new (or another
  // forced sibling). Matching Slack: continue-in-thread gets history; a fresh
  // task must start clean. Top-level channel launches never dump unrelated
  // channel history into the agent prompt.
  const includeFullThreadContext =
    input.channel.isThread && !input.forceNewThread;
  const [history, installation] = await Promise.all([
    includeFullThreadContext
      ? fetchThreadHistoryBestEffort({
          provider: input.provider,
          channelId: input.channel.channelId,
        })
      : Promise.resolve([] as DiscordThreadHistoryMessage[]),
    input.channel.guildId
      ? findDiscordInstallationByGuildId(input.channel.guildId)
      : Promise.resolve(null),
  ]);
  const triggeringMessage: DiscordThreadHistoryMessage = {
    id: input.queuedMessage.ts,
    user: input.queuedMessage.user,
    text: input.queuedMessage.text,
    attachments: [],
  };
  const historyWithTrigger = history.some(
    (message) => message.id === triggeringMessage.id,
  )
    ? history
    : [...history, triggeringMessage];
  // Router keeps its own last-N budgetary slice; pass the reconstructed
  // transcript only when this launch inherits the thread.
  const routingThreadMessages = includeFullThreadContext
    ? historyWithTrigger.map((message) => ({
        user: message.username ?? message.user,
        text: message.text,
      }))
    : [
        {
          user: triggeringMessage.user,
          text: triggeringMessage.text,
        },
      ];
  const historyAttachments = includeFullThreadContext
    ? toDiscordAttachmentsFromHistory(history, {
        excludeMessageId: input.queuedMessage.ts,
      })
    : [];
  const threadAttachments = historyAttachments.length
    ? await processDiscordAttachments(historyAttachments)
    : { images: [], attachmentTexts: [], warnings: [] };
  for (const warning of threadAttachments.warnings) {
    console.warn(`[discord] Thread attachment warning: ${warning}`);
  }

  const taskDescriptionWithAttachments = appendAttachmentTextsToPromptText({
    text: input.queuedMessage.text,
    attachmentTexts: threadAttachments.attachmentTexts,
  });
  const allImages = [
    ...(input.queuedMessage.images ?? []),
    ...threadAttachments.images,
  ];
  const threadContext = includeFullThreadContext
    ? formatDiscordThreadContext({
        messages: historyWithTrigger,
        currentMessageId: input.queuedMessage.ts,
      })
    : undefined;
  const agentPromptPrefix = input.channelAutoStart?.agentPromptPrefix?.trim();
  const agentPromptBody = [threadContext, taskDescriptionWithAttachments]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n');
  const agentPromptText = agentPromptPrefix
    ? `${agentPromptPrefix}\n\n${agentPromptBody}`
    : agentPromptBody !== input.queuedMessage.text
      ? agentPromptBody
      : undefined;
  const routingContext = await buildDiscordRoutingContext({
    userId: input.launchOwnerUserId,
    taskDescription: taskDescriptionWithAttachments,
    guildName: installation?.guildName ?? undefined,
    channelName: input.channel.channelName,
    threadMessages: routingThreadMessages,
    ...(allImages.length ? { images: allImages } : {}),
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
      queuedMessage: {
        ...input.queuedMessage,
        ...(allImages.length ? { images: allImages } : {}),
      },
      metadata: input.metadata,
      routingContext,
      channel: input.channel,
      routingDecision,
      forceNewThread: input.forceNewThread,
      ...(agentPromptText ? { agentPromptText } : {}),
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
    ...(agentPromptText ? { agentPromptText } : {}),
    queuedMessage: {
      ...input.queuedMessage,
      ...(allImages.length ? { images: allImages } : {}),
    },
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
        ? { buttons: [[{ text: 'Follow', url: launched.taskUrl }]] }
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

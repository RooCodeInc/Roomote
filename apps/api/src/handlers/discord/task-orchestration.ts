import { Env } from '@roomote/env';
import { appendAttachmentTextsToPromptText } from '@roomote/cloud-agents';
import {
  buildDiscordRoutingContext,
  getTaskUrl,
  routeTask,
} from '@roomote/cloud-agents/server';
import {
  isDiscordAudioAttachment,
  type DiscordInteraction,
} from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { findDiscordInstallationByGuildId } from '@roomote/sdk/server';
import {
  ALL_REPOSITORIES,
  type QueuedCommunicationMessage,
  type TaskInitiator,
} from '@roomote/types';

import type { DiscordEventCommunicationMetadata } from '@roomote/communication/discord-event';
import { findCommunicationTaskRunBySourceEvent } from '@roomote/sdk/server/communication';
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
  type DiscordWorkspaceSelection,
} from './task-launch.js';
import {
  fetchDiscordRepliedToMessageBestEffort,
  fetchDiscordThreadHistoryBestEffort,
  formatDiscordThreadContext,
  markDiscordThreadHistoryDelivered,
  mergeDiscordRepliedToMessage,
  toDiscordAttachmentsFromHistory,
  type DiscordThreadHistoryMessage,
} from './thread-context.js';

function compareDiscordMessageIds(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
  } catch {
    return left.localeCompare(right);
  }
}

/**
 * Soft-clear the MESSAGE_CREATE intake 👀 when a path ends without a worker.
 * Platform answers and auto-start skips never hit onStart cleanup.
 */
async function clearDiscordIntakeAckBestEffort(input: {
  provider: DiscordCommunicationProvider;
  channel: DiscordChannelContext;
  metadata: DiscordEventCommunicationMetadata;
  intakeAckPinned?: boolean;
}): Promise<void> {
  const messageId = input.metadata.communicationAnchorMessageId;
  if (!input.intakeAckPinned || !messageId || !input.provider.removeReaction) {
    return;
  }

  await input.provider
    .removeReaction({
      channelId: input.channel.channelId,
      messageId,
      name: 'eyes',
    })
    .catch(() => undefined);
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
  fastAgentSessionId?: string;
  workspaceOverride?: DiscordWorkspaceSelection;
  /**
   * True when the Discord intake path successfully pinned 👀 on the origin
   * message before calling into launch (soft-ack failures stay false).
   */
  intakeAckPinned?: boolean;
  /**
   * Discord `message_reference.message_id` when the triggering mention is a
   * client reply. Always folded into thread context so channel-level replies
   * still carry the original message without dumping whole-channel history.
   */
  replyToMessageId?: string;
  /** Discord `message_reference.channel_id` when present. */
  replyToChannelId?: string;
  /** Real Discord message included as the endpoint of synthetic reaction context. */
  contextThroughMessageId?: string;
}) {
  const existingRun = await findCommunicationTaskRunBySourceEvent({
    provider: 'discord',
    sourceEventId: input.queuedMessage.ts,
  }).catch(async (error) => {
    await clearDiscordIntakeAckBestEffort(input);
    throw error;
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
    await clearDiscordIntakeAckBestEffort(input);
    return {
      status: 'already_started' as const,
      existingRun,
      taskUrl,
    };
  }

  try {
    // Full transcript + prior attachments belong on task start only when the
    // launch already lives inside a Discord thread and is not /new (or another
    // forced sibling). Matching Slack: continue-in-thread gets history; a fresh
    // task must start clean. Top-level channel launches never dump unrelated
    // channel history into the agent prompt — except the single message the user
    // explicitly replied to via Discord's reply UI.
    const includeFullThreadContext =
      input.channel.isThread && !input.forceNewThread;
    const shouldFetchRepliedTo =
      Boolean(input.replyToMessageId) && !input.forceNewThread;
    const [historyBase, repliedToMessage, installation] = await Promise.all([
      includeFullThreadContext
        ? fetchDiscordThreadHistoryBestEffort({
            provider: input.provider,
            channelId: input.channel.channelId,
            ...(input.channel.parentChannelId
              ? { parentChannelId: input.channel.parentChannelId }
              : {}),
          })
        : Promise.resolve([] as DiscordThreadHistoryMessage[]),
      shouldFetchRepliedTo && input.replyToMessageId
        ? fetchDiscordRepliedToMessageBestEffort({
            provider: input.provider,
            channelId:
              input.replyToChannelId ??
              input.channel.parentChannelId ??
              input.channel.channelId,
            messageId: input.replyToMessageId,
          })
        : Promise.resolve(null),
      input.channel.guildId
        ? findDiscordInstallationByGuildId(input.channel.guildId)
        : Promise.resolve(null),
    ]);
    const history = mergeDiscordRepliedToMessage({
      messages: historyBase,
      repliedTo: repliedToMessage,
    });
    const triggeringMessage: DiscordThreadHistoryMessage = {
      id: input.queuedMessage.ts,
      user: input.queuedMessage.user,
      text: input.queuedMessage.text,
      attachments: [],
    };
    const contextThroughMessageId = input.contextThroughMessageId;
    const contextHistory = contextThroughMessageId
      ? history.filter(
          (message) =>
            compareDiscordMessageIds(message.id, contextThroughMessageId) <= 0,
        )
      : history;
    const historyWithTrigger = contextHistory.some(
      (message) => message.id === triggeringMessage.id,
    )
      ? contextHistory
      : [...contextHistory, triggeringMessage];
    // Full thread launches get the reconstructed transcript; top-level channel
    // reply launches only pass the explicit reply target + current turn.
    const includeReplyContext =
      includeFullThreadContext ||
      (Boolean(repliedToMessage) && !input.forceNewThread);
    const routingThreadMessages = includeReplyContext
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
    const historyAttachments = includeReplyContext
      ? toDiscordAttachmentsFromHistory(contextHistory, {
          excludeMessageId: input.queuedMessage.ts,
        })
      : [];
    const threadAttachments = historyAttachments.length
      ? historyAttachments.some(isDiscordAudioAttachment)
        ? await processDiscordAttachments(historyAttachments, {
            userId: input.queuedMessage.userId,
            userTextContext: input.queuedMessage.text,
          })
        : await processDiscordAttachments(historyAttachments)
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
    const threadContext = includeReplyContext
      ? formatDiscordThreadContext({
          messages: historyWithTrigger,
          currentMessageId: contextThroughMessageId ?? input.queuedMessage.ts,
          ...(contextThroughMessageId ? { includeCurrentMessage: true } : {}),
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
    if (
      routingDecision.status === 'platform_answer' &&
      !input.workspaceOverride
    ) {
      // Auto-respond channels must not turn Roomote into a channel chatbot:
      // a question-shaped message that routes to a platform answer is skipped
      // silently (mirrors Slack's auto-routed path, which never posts answers).
      if (input.channelAutoStart) {
        await clearDiscordIntakeAckBestEffort(input);
        return { status: 'skipped_platform_answer' as const, routingDecision };
      }
      await replyToDiscordEvent({
        provider: input.provider,
        applicationId: input.applicationId,
        channel: input.channel,
        ...(input.interaction ? { interaction: input.interaction } : {}),
        text: routingDecision.result.answer,
      });
      // No worker onStart fires for inline answers; clear intake 👀 here.
      await clearDiscordIntakeAckBestEffort(input);
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
        ...(input.intakeAckPinned ? { intakeAckPinned: true } : {}),
      });
      if (includeReplyContext) {
        await markDiscordThreadHistoryDelivered({
          channelId: input.channel.channelId,
          messageIds: historyWithTrigger.map((message) => message.id),
        });
      }
      return {
        status: 'confirmation_pending' as const,
        routingDecision,
        pendingRouteId: confirmation.pendingRouteId,
      };
    }

    const workspace =
      input.workspaceOverride ??
      (routingDecision.status === 'routed'
        ? await resolveDiscordWorkspace(routingDecision.result.workspace)
        : {
            repoForPayload: ALL_REPOSITORIES,
            workspaceDisplayName: 'all repos',
          });
    if (!workspace) {
      throw new Error(
        'Discord task routing selected an unavailable workspace.',
      );
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
      ...(input.fastAgentSessionId
        ? { fastAgentSessionId: input.fastAgentSessionId }
        : {}),
      ...(kickoffMessage ? { kickoffMessage } : {}),
      ...(input.intakeAckPinned ? { intakeAckPinned: true } : {}),
    });
    if (includeReplyContext) {
      await markDiscordThreadHistoryDelivered({
        channelId: input.channel.channelId,
        messageIds: historyWithTrigger.map((message) => message.id),
      });
    }
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
  } catch (error) {
    await clearDiscordIntakeAckBestEffort(input);
    throw error;
  }
}

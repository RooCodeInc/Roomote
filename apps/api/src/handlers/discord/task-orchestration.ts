import { appendAttachmentTextsToPromptText } from '@roomote/cloud-agents';
import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  isDiscordAudioAttachment,
  type DiscordInteraction,
} from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import type {
  FastAgentParent,
  QueuedCommunicationMessage,
  TaskInitiator,
} from '@roomote/types';

import type { DiscordEventCommunicationMetadata } from '@roomote/communication/discord-event';
import { findCommunicationTaskRunBySourceEvent } from '@roomote/sdk/server/communication';
import { processDiscordAttachments } from './attachments.js';
import { replyToDiscordEvent } from './replies.js';
import {
  launchDiscordTask,
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

/**
 * Launches a Discord task into a workspace that is already decided, either by
 * the Fast orchestrator's delegation or by a pinned suggestion card. The
 * thread history and any attachments in it travel with the task as context.
 */
export async function startNewDiscordTask(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  requesterDiscordUserId: string;
  /** Absent only for automation-owned launches. */
  launchOwnerUserId?: string;
  /** Attribution override; takes precedence over the default user initiator. */
  initiator?: TaskInitiator;
  queuedMessage: QueuedCommunicationMessage;
  metadata: DiscordEventCommunicationMetadata;
  channel: DiscordChannelContext;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  /** The workspace the task runs in; never decided here. */
  workspace: DiscordWorkspaceSelection;
  forceNewThread?: boolean;
  model?: string | null;
  fastAgentSessionId?: string;
  fastAgentParent?: FastAgentParent;
  /** Fast owns the visible acknowledgement and must post it before the child
   * becomes runnable. Other Discord launches use the standard task card. */
  beforeEnqueueKickoff?: (task: {
    taskId: string;
    taskUrl?: string;
  }) => Promise<void>;
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
    if (!input.beforeEnqueueKickoff) {
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
    // launch already lives inside a Discord thread and is not a forced
    // sibling. Top-level channel launches never dump unrelated channel history
    // into the agent prompt, except the single message the user explicitly
    // replied to via Discord's reply UI.
    const includeFullThreadContext =
      input.channel.isThread && !input.forceNewThread;
    const shouldFetchRepliedTo =
      Boolean(input.replyToMessageId) && !input.forceNewThread;
    const [historyBase, repliedToMessage] = await Promise.all([
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
    const agentPromptBody = [threadContext, taskDescriptionWithAttachments]
      .filter((part): part is string => Boolean(part?.trim()))
      .join('\n\n');
    const agentPromptText =
      agentPromptBody !== input.queuedMessage.text
        ? agentPromptBody
        : undefined;

    const launched = await launchDiscordTask({
      provider: input.provider,
      launchOwnerUserId: input.launchOwnerUserId,
      ...(input.initiator ? { initiator: input.initiator } : {}),
      ...(agentPromptText ? { agentPromptText } : {}),
      queuedMessage: {
        ...input.queuedMessage,
        ...(allImages.length ? { images: allImages } : {}),
      },
      metadata: input.metadata,
      channel: input.channel,
      workspace: input.workspace,
      forceNewThread: input.forceNewThread,
      ...(input.model ? { model: input.model } : {}),
      ...(input.fastAgentSessionId
        ? { fastAgentSessionId: input.fastAgentSessionId }
        : {}),
      ...(input.fastAgentParent
        ? { fastAgentParent: input.fastAgentParent }
        : {}),
      ...(input.beforeEnqueueKickoff
        ? { beforeEnqueueKickoff: input.beforeEnqueueKickoff }
        : {}),
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
          ? `Started in **${input.workspace.workspaceDisplayName}**. Continue in the new task thread.`
          : `Started in **${input.workspace.workspaceDisplayName}**.`,
        ...(launched.taskUrl
          ? { buttons: [[{ text: 'Follow', url: launched.taskUrl }]] }
          : {}),
      });
    }
    return {
      status: 'started' as const,
      workspace: input.workspace,
      ...launched,
    };
  } catch (error) {
    await clearDiscordIntakeAckBestEffort(input);
    throw error;
  }
}

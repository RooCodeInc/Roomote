import type {
  TelegramMessage,
  TelegramUpdateCommunicationMetadata,
} from '@roomote/communication/telegram-update';
import { Env } from '@roomote/env';
import { ALL_REPOSITORIES } from '@roomote/types';
import {
  buildTelegramRoutingContext,
  getTaskUrl,
  routeTask,
} from '@roomote/cloud-agents/server';

import type { CompletedTelegramTaskRun } from './task-run-lookup.js';
import { maybeRequestTelegramRoutingConfirmation } from './routing-confirmation.js';
import {
  postTelegramMessageBestEffort,
  telegramPrivateTopicsEnabledBestEffort,
} from './replies.js';
import {
  launchTelegramTask,
  resolveTelegramWorkspace,
  shouldCreateTelegramTaskTopic,
} from './task-launch.js';
import type {
  QueuedTelegramCommunicationMessage,
  TelegramConversationRef,
} from './types.js';
import { resumeCommunicationTaskFromSnapshot } from '../tasks/communication-snapshot-resume.js';

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

export async function resumeTelegramTaskFromSnapshot(input: {
  completedRun: CompletedTelegramTaskRun;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
}) {
  return resumeCommunicationTaskFromSnapshot({
    provider: 'telegram',
    completedRun: input.completedRun,
    queuedMessage: input.queuedMessage,
    channelId: input.metadata.communicationChannelId,
    threadId: input.metadata.communicationThreadId,
    messageId: input.metadata.communicationMessageId,
    preservePayloadFlags: ['telegramTaskTopic'],
  });
}

export async function replyToTelegramSnapshotResume(input: {
  launchResult: Awaited<ReturnType<typeof resumeTelegramTaskFromSnapshot>>;
  conversation: TelegramConversationRef & { replyToMessageId?: string };
}): Promise<void> {
  await postTelegramMessageBestEffort({
    chatId: input.conversation.chatId,
    threadId: input.conversation.threadId,
    replyToMessageId: input.conversation.replyToMessageId,
    text: `Reconnected this Telegram chat to the task: ${getTaskUrl({
      taskId: input.launchResult.taskId,
      utm: {
        source: 'telegram',
        campaign: 'telegram.snapshot_resume',
      },
    })}`,
  });
}

export async function startNewTelegramTask(input: {
  message: TelegramMessage;
  launchOwnerUserId: string;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
  /**
   * Launch without the routing-confirmation card. Used when the user already
   * expressed explicit intent (for example a suggestion button click).
   */
  skipRoutingConfirmation?: boolean;
  /** Start a new task topic even when the command came from an older topic. */
  forceNewTopic?: boolean;
}) {
  const needsPrivateTopicCapability =
    input.message.chat.type.toLowerCase() === 'private' &&
    (!input.metadata.communicationThreadId || input.forceNewTopic === true);
  const createTopicForTask = shouldCreateTelegramTaskTopic({
    chatType: input.message.chat.type,
    isForum: input.message.chat.is_forum,
    privateTopicsEnabled: needsPrivateTopicCapability
      ? await telegramPrivateTopicsEnabledBestEffort()
      : false,
    threadId: input.metadata.communicationThreadId,
    forceNewTopic: input.forceNewTopic,
  });
  const routingContext = await buildTelegramRoutingContext({
    userId: input.launchOwnerUserId,
    taskDescription: input.queuedMessage.text,
    chatName:
      cleanOptionalString(input.message.chat.title) ??
      cleanOptionalString(input.message.chat.username) ??
      input.queuedMessage.channel,
    threadMessages: [
      {
        user: input.queuedMessage.user,
        text: input.queuedMessage.text,
      },
    ],
    ...(input.queuedMessage.images?.length
      ? { images: input.queuedMessage.images }
      : {}),
    apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
  });
  const routingDecision = await routeTask(routingContext);

  if (routingDecision.status === 'platform_answer') {
    await postTelegramMessageBestEffort({
      chatId: input.metadata.communicationChannelId,
      threadId: input.metadata.communicationThreadId,
      replyToMessageId: input.metadata.communicationMessageId,
      text: routingDecision.result.answer,
      textFormat: 'markdown',
    });

    return {
      status: 'replied_inline' as const,
      routingDecision,
    };
  }

  if (!input.skipRoutingConfirmation) {
    const confirmation = await maybeRequestTelegramRoutingConfirmation({
      routingDecision,
      launchOwnerUserId: input.launchOwnerUserId,
      queuedMessage: input.queuedMessage,
      metadata: input.metadata,
      createTopicForTask,
    });

    if (confirmation) {
      return {
        status: 'confirmation_pending' as const,
        routingDecision,
        pendingRouteId: confirmation.pendingRouteId,
      };
    }
  }

  const workspace =
    routingDecision.status === 'routed'
      ? await resolveTelegramWorkspace(routingDecision.result.workspace)
      : {
          repoForPayload: ALL_REPOSITORIES,
          workspaceDisplayName: 'all repos',
        };

  if (!workspace) {
    throw new Error('Telegram task routing selected an unavailable workspace.');
  }

  const launchResult = await launchTelegramTask({
    launchOwnerUserId: input.launchOwnerUserId,
    queuedMessage: input.queuedMessage,
    metadata: input.metadata,
    workspace,
    createTopicForTask,
  });

  return {
    status: 'started' as const,
    launchResult,
    routingDecision,
    workspace,
  };
}

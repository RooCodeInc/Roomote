import type { TelegramUpdateCommunicationMetadata } from '@roomote/communication/telegram-update';
import { getTaskUrl } from '@roomote/cloud-agents/server';

import type { CompletedTelegramTaskRun } from './task-run-lookup.js';
import { postTelegramMessageBestEffort } from './replies.js';
import type {
  QueuedTelegramCommunicationMessage,
  TelegramConversationRef,
} from './types.js';
import { resumeCommunicationTaskFromSnapshot } from '@roomote/sdk/server/communication';

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

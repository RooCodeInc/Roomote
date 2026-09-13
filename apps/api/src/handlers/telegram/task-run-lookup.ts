import {
  findActiveCommunicationTaskRun,
  findCompletedCommunicationTaskRunWithSnapshot,
  findTaskBackedAutomationReportRun,
} from '@roomote/sdk/server/communication';
import type { TelegramConversationRef } from './types.js';

export async function findActiveTelegramTaskRun(
  input: TelegramConversationRef,
) {
  return findActiveCommunicationTaskRun({
    provider: 'telegram',
    channelId: input.chatId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
}

export async function findCompletedTelegramTaskRunWithSnapshot(
  input: TelegramConversationRef,
) {
  return findCompletedCommunicationTaskRunWithSnapshot({
    provider: 'telegram',
    channelId: input.chatId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
}

export async function findTelegramAutomationReportRun(input: {
  chatId: string;
  messageId: string;
}) {
  return findTaskBackedAutomationReportRun({
    provider: 'telegram',
    channelId: input.chatId,
    messageId: input.messageId,
  });
}

export type CompletedTelegramTaskRun = NonNullable<
  Awaited<ReturnType<typeof findCompletedTelegramTaskRunWithSnapshot>>
>;

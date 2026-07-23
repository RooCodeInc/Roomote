import {
  findActiveCommunicationTaskRun,
  findCompletedCommunicationTaskRunWithSnapshot,
} from '@roomote/sdk/server';
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

export type CompletedTelegramTaskRun = NonNullable<
  Awaited<ReturnType<typeof findCompletedTelegramTaskRunWithSnapshot>>
>;

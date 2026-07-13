import type { CommunicationMessageButton } from '@roomote/communication';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';

import { apiLogger } from '../../logging.js';

async function createTelegramCommunicationProvider(): Promise<TelegramCommunicationProvider | null> {
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return null;
  }

  return new TelegramCommunicationProvider({ botToken });
}

const TELEGRAM_BOT_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
let privateTopicsCapabilityCache:
  | { botToken: string; enabled: boolean; expiresAt: number }
  | undefined;

export async function telegramPrivateTopicsEnabledBestEffort(): Promise<boolean> {
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) return false;

  const now = Date.now();
  if (
    privateTopicsCapabilityCache?.botToken === botToken &&
    privateTopicsCapabilityCache.expiresAt > now
  ) {
    return privateTopicsCapabilityCache.enabled;
  }

  try {
    const { hasTopicsEnabled } = await new TelegramCommunicationProvider({
      botToken,
    }).getBotInfo();
    privateTopicsCapabilityCache = {
      botToken,
      enabled: hasTopicsEnabled,
      expiresAt: now + TELEGRAM_BOT_INFO_CACHE_TTL_MS,
    };
    return hasTopicsEnabled;
  } catch (error) {
    apiLogger.debug(
      `[telegram] Could not read bot topic capabilities: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export async function postTelegramMessageBestEffort(input: {
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  text: string;
  textFormat?: 'plain' | 'markdown';
  buttons?: CommunicationMessageButton[][];
}): Promise<{ messageId: string } | null> {
  const provider = await createTelegramCommunicationProvider();

  if (!provider) {
    apiLogger.warn(
      '[telegram] Skipping Telegram reply because bot token is not configured',
    );
    return null;
  }

  try {
    const result = await provider.postMessage({
      channelId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.replyToMessageId
        ? { replyToMessageId: input.replyToMessageId }
        : {}),
      text: input.text,
      ...(input.textFormat ? { textFormat: input.textFormat } : {}),
      ...(input.buttons ? { buttons: input.buttons } : {}),
    });

    return { messageId: result.messageId };
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to post Telegram reply: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function createTelegramForumTopicBestEffort(input: {
  chatId: string;
  name: string;
}): Promise<{ threadId: string } | null> {
  const provider = await createTelegramCommunicationProvider();

  if (!provider) {
    apiLogger.warn(
      '[telegram] Skipping Telegram topic creation because bot token is not configured',
    );
    return null;
  }

  try {
    const topic = await provider.createForumTopic({
      channelId: input.chatId,
      name: input.name,
    });

    return { threadId: topic.messageThreadId };
  } catch (error) {
    // Topic creation is an enhancement over the existing chat flow. A bot
    // without private-chat Threaded Mode, or without manage-topics rights in
    // a forum supergroup, must still be able to launch the task normally.
    apiLogger.debug(
      `[telegram] Could not create a task topic; falling back to the current chat: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function editTelegramForumTopicBestEffort(input: {
  chatId: string;
  threadId: string;
  name: string;
}): Promise<boolean> {
  const provider = await createTelegramCommunicationProvider();

  if (!provider) {
    return false;
  }

  try {
    await provider.editForumTopic({
      channelId: input.chatId,
      threadId: input.threadId,
      name: input.name,
    });
    return true;
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to rename implicit task topic: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** Replace the text and keyboard of a bot message (cards, status lines). */
export async function editTelegramMessageBestEffort(input: {
  chatId: string;
  messageId: string;
  text: string;
  textFormat?: 'plain' | 'markdown';
  buttons?: CommunicationMessageButton[][];
}): Promise<boolean> {
  const provider = await createTelegramCommunicationProvider();

  if (!provider) {
    return false;
  }

  try {
    await provider.editMessageText({
      channelId: input.chatId,
      messageId: input.messageId,
      text: input.text,
      ...(input.textFormat ? { textFormat: input.textFormat } : {}),
      ...(input.buttons ? { buttons: input.buttons } : {}),
    });
    return true;
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to edit Telegram message: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** Answer a callback query so the clicked button stops showing a spinner. */
export async function answerTelegramCallbackQueryBestEffort(input: {
  callbackQueryId: string;
  text?: string;
}): Promise<void> {
  const provider = await createTelegramCommunicationProvider();

  if (!provider) {
    return;
  }

  try {
    await provider.answerCallbackQuery(input);
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to answer Telegram callback query: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Remove the inline keyboard from a previously sent message. */
export async function clearTelegramMessageButtonsBestEffort(input: {
  chatId: string;
  messageId: string;
}): Promise<void> {
  const provider = await createTelegramCommunicationProvider();

  if (!provider) {
    return;
  }

  try {
    await provider.editMessageReplyMarkup({
      channelId: input.chatId,
      messageId: input.messageId,
    });
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to clear Telegram message buttons: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const TELEGRAM_ACK_REACTION = 'eyes';

/**
 * Mirror Slack's inbound-message ack reaction so the sender sees the bot
 * picked the message up before a task reply lands.
 */
export async function ackTelegramMessageBestEffort(input: {
  chatId: string;
  messageId: string | undefined;
}): Promise<void> {
  const provider = await createTelegramCommunicationProvider();

  if (!provider || !input.messageId) {
    return;
  }

  try {
    await provider.addReaction({
      channelId: input.chatId,
      messageId: input.messageId,
      name: TELEGRAM_ACK_REACTION,
    });
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to add Telegram ack reaction: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

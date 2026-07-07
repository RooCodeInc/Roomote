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

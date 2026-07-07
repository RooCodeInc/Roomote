import { db, environmentVariables } from '@roomote/db/server';
import { TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME } from '@roomote/sdk/server/telegram-primary-chat';

import { apiLogger } from '../../logging.js';

// The lookup half moved to @roomote/sdk so the web setup flow can target the
// same proactive Telegram destination; this module keeps the historical
// apps/api import path. The narrow subpath import keeps the full sdk server
// barrel out of this handler's module graph.
export { findTelegramPrimaryChatId } from '@roomote/sdk/server/telegram-primary-chat';

/**
 * The operator's private chat with the bot is the destination for proactive
 * messages (onboarding, starter suggestions). The first private chat that
 * reaches the webhook wins; the value can be corrected later from settings.
 */
export async function captureTelegramPrimaryChatBestEffort(input: {
  chatId: string;
  launchOwnerUserId: string;
}): Promise<void> {
  try {
    await db
      .insert(environmentVariables)
      .values({
        name: TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME,
        value: input.chatId,
        createdByUserId: input.launchOwnerUserId,
        lastUpdatedByUserId: input.launchOwnerUserId,
      })
      .onConflictDoNothing({ target: environmentVariables.name });
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to capture Telegram primary chat: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

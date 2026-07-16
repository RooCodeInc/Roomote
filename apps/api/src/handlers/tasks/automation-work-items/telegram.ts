import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';

import { findTelegramPrimaryChatId } from '../../telegram/primary-chat.js';
import { postTelegramMessageInNewTopicBestEffort } from '../../telegram/replies.js';
import { buildSuggestionBadgePrefix } from '../../slack/helpers/suggestion-workspace.js';
import type { PersistedAutomationWorkItem } from './types.js';

/**
 * Resolves the captured Telegram primary chat. The caller applies provider
 * precedence before invoking this fallback.
 */
export async function resolveAutomationTelegramTarget(): Promise<{
  provider: 'telegram';
  chatId: string;
} | null> {
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return null;
  }

  const chatId = await findTelegramPrimaryChatId();

  if (!chatId) {
    return null;
  }

  return { provider: 'telegram', chatId };
}

export async function postLateBoundWorkItemFailureToTelegram(params: {
  chatId: string;
  workItem: PersistedAutomationWorkItem;
  reason: string;
}): Promise<void> {
  const text = [
    `**${buildSuggestionBadgePrefix({
      category: params.workItem.category,
      priority: params.workItem.priority,
    })}${params.workItem.title}**`,
    params.workItem.brief,
    '',
    `An automation queued this work item, but the execution task failed to launch: ${params.reason}`,
  ].join('\n');

  await postTelegramMessageInNewTopicBestEffort({
    chatId: params.chatId,
    topicName: params.workItem.title,
    text,
    textFormat: 'markdown',
  });
}

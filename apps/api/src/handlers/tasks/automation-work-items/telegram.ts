import {
  db,
  eq,
  resolveTelegramRuntimeCredentials,
  slackInstallations,
} from '@roomote/db/server';

import { findTelegramPrimaryChatId } from '../../telegram/primary-chat.js';
import { postTelegramMessageBestEffort } from '../../telegram/replies.js';
import { buildSuggestionBadgePrefix } from '../../slack/helpers/suggestion-workspace.js';
import type { PersistedAutomationWorkItem } from './types.js';

/**
 * Telegram destination for automation execution output when the deployment
 * has no Slack installation: the captured primary chat.
 */
export async function resolveAutomationTelegramTarget(): Promise<{
  provider: 'telegram';
  chatId: string;
} | null> {
  // Match the summary path's gate (postScheduledSuggestionsToTelegram):
  // Slack-installed deployments keep automation output on Slack even when a
  // channel is temporarily unresolvable, so summaries and execution
  // closeouts never split across surfaces.
  const [slackInstallation] = await db
    .select({ id: slackInstallations.id })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  if (slackInstallation) {
    return null;
  }

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

  await postTelegramMessageBestEffort({
    chatId: params.chatId,
    text,
    textFormat: 'markdown',
  });
}

import type { CommunicationMessageButton } from '@roomote/communication';
import {
  agentSuggestionMessages,
  and,
  db,
  eq,
  like,
  resolveTelegramRuntimeCredentials,
  slackInstallations,
} from '@roomote/db/server';

import { apiLogger } from '../../logging.js';
import { resolveScheduledSuggestionSlackConfig } from '../tasks/background-automation-slack.js';
import { buildScheduledSuggestionRootMessage } from '../tasks/scheduled-suggestion-root-summary.js';
import { findTelegramPrimaryChatId } from './primary-chat.js';
import { postTelegramMessageBestEffort } from './replies.js';

const MAX_TELEGRAM_AUTOMATION_SUGGESTIONS = 5;

type TelegramAutomationSuggestion = {
  id: string;
  title: string;
  brief: string;
  category: string | null;
  targetRepositoryFullName: string | null;
};

async function hasActiveSlackInstallation(): Promise<boolean> {
  const [installation] = await db
    .select({ id: slackInstallations.id })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  return Boolean(installation);
}

/**
 * Telegram counterpart of the scheduled-automation Slack summaries
 * (suggester, Sentry triage, Dependabot triage, security/code-quality
 * auditors, CI failure triage). Runs only when the deployment has no active
 * Slack installation, and posts one message to the captured primary chat:
 * the automation's summary plus a start button per suggestion — the same
 * single-notification shape as the onboarding suggestions intro.
 */
export async function postScheduledSuggestionsToTelegram(params: {
  sourceTaskId: string;
  createdByUserId: string | null;
  suggestionSource?: Parameters<
    typeof resolveScheduledSuggestionSlackConfig
  >[0];
  suggestions: TelegramAutomationSuggestion[];
}): Promise<void> {
  const { sourceTaskId, createdByUserId, suggestions } = params;

  if (!createdByUserId || suggestions.length === 0 || !sourceTaskId.trim()) {
    return;
  }

  if (await hasActiveSlackInstallation()) {
    return;
  }

  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return;
  }

  const chatId = await findTelegramPrimaryChatId();

  if (!chatId) {
    apiLogger.debug(
      `[AutomationSuggestionLifecycle] Skip Telegram automation summary because no primary chat is captured for sourceTaskId=${sourceTaskId}`,
    );
    return;
  }

  const slackConfig = resolveScheduledSuggestionSlackConfig(
    params.suggestionSource,
  );

  const [existingSummaryMessage] = await db
    .select({ id: agentSuggestionMessages.id })
    .from(agentSuggestionMessages)
    .where(
      and(
        eq(agentSuggestionMessages.agentType, slackConfig.agentType),
        like(agentSuggestionMessages.suggestionKey, `${sourceTaskId}:%`),
      ),
    )
    .limit(1);

  if (existingSummaryMessage) {
    apiLogger.debug(
      `[AutomationSuggestionLifecycle] Skip Telegram automation summary because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
    );
    return;
  }

  const rootMessage = await buildScheduledSuggestionRootMessage({
    slackConfig,
    actionFooterText: slackConfig.actionFooterText,
    suggestions,
  });
  const limitedSuggestions = suggestions.slice(
    0,
    MAX_TELEGRAM_AUTOMATION_SUGGESTIONS,
  );
  const overflowCount = suggestions.length - limitedSuggestions.length;
  const messageLines = [
    rootMessage.summaryText,
    '',
    ...limitedSuggestions.map(
      (suggestion, index) =>
        `**${index + 1}. ${suggestion.title}**\n${suggestion.brief}`,
    ),
    ...(overflowCount > 0
      ? ['', `…and ${overflowCount} more in the task view.`]
      : []),
  ];
  const buttons: CommunicationMessageButton[][] = limitedSuggestions.map(
    (suggestion, index) => [
      {
        text: `▶️ Start ${index + 1}`,
        callbackData: `idea:${suggestion.id}`,
      },
    ],
  );

  const posted = await postTelegramMessageBestEffort({
    chatId,
    text: messageLines.join('\n'),
    textFormat: 'markdown',
    buttons,
  });

  if (!posted) {
    return;
  }

  await db
    .insert(agentSuggestionMessages)
    .values(
      limitedSuggestions.map((suggestion) => ({
        agentType: slackConfig.agentType,
        // (channelId, messageTs) is unique; suffix the suggestion id so
        // every tracked row survives the batch insert for a single message.
        messageTs: `${posted.messageId}:${suggestion.id}`,
        channelId: chatId,
        suggestionKey: `${sourceTaskId}:${suggestion.id}`,
        createdByUserId,
      })),
    )
    .onConflictDoNothing();

  apiLogger.debug(
    `[AutomationSuggestionLifecycle] Published ${limitedSuggestions.length} ${slackConfig.automationKey} suggestions to Telegram chat ${chatId} for sourceTaskId=${sourceTaskId}`,
  );
}

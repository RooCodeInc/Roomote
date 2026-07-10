import type { CommunicationMessageButton } from '@roomote/communication';
import {
  and,
  db,
  eq,
  resolveTelegramRuntimeCredentials,
  sql,
  trackedMessages,
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

/**
 * Telegram counterpart of the scheduled-automation Slack summaries
 * (suggester, Sentry triage, Dependabot triage, security/code-quality
 * auditors, CI failure triage). Posts one message to the captured primary
 * chat: the automation's summary plus a start button per suggestion — the same
 * single-notification shape as the onboarding suggestions intro.
 *
 * Returns whether the summary was DELIVERED (posted now, or already present
 * from a prior run). Surface precedence (Slack > Telegram > Teams) is owned by
 * the caller in submitTaskSuggestions, which only invokes this when Slack did
 * not deliver — this function no longer self-suppresses on Slack existence.
 */
export async function postScheduledSuggestionsToTelegram(params: {
  sourceTaskId: string;
  createdByUserId: string | null;
  suggestionSource?: Parameters<
    typeof resolveScheduledSuggestionSlackConfig
  >[0];
  suggestions: TelegramAutomationSuggestion[];
}): Promise<boolean> {
  const { sourceTaskId, createdByUserId, suggestions } = params;

  // Automation-initiated scans have no user, so createdByUserId is null. That
  // must not suppress the fallback post; the tracked_messages column is
  // nullable and no user attribution is rendered here.
  if (suggestions.length === 0 || !sourceTaskId.trim()) {
    return false;
  }

  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return false;
  }

  const chatId = await findTelegramPrimaryChatId();

  if (!chatId) {
    apiLogger.debug(
      `[AutomationSuggestionLifecycle] Skip Telegram automation summary because no primary chat is captured for sourceTaskId=${sourceTaskId}`,
    );
    return false;
  }

  const slackConfig = resolveScheduledSuggestionSlackConfig(
    params.suggestionSource,
  );

  const [existingSummaryMessage] = await db
    .select({ id: trackedMessages.id })
    .from(trackedMessages)
    .where(
      and(
        eq(trackedMessages.kind, 'suggestion_card'),
        sql`${trackedMessages.metadata} ->> 'suggestionType' = ${slackConfig.suggestionType}`,
        sql`${trackedMessages.metadata} ->> 'suggestionKey' LIKE ${`${sourceTaskId}:%`}`,
      ),
    )
    .limit(1);

  if (existingSummaryMessage) {
    apiLogger.debug(
      `[AutomationSuggestionLifecycle] Skip Telegram automation summary because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
    );
    // Already delivered on a prior run; suppress the Teams fallback.
    return true;
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
    return false;
  }

  await db
    .insert(trackedMessages)
    .values(
      limitedSuggestions.map((suggestion) => {
        // (kind, dedupeKey) is unique; suffix the suggestion id on messageTs
        // so every tracked row survives the batch insert for a single message.
        const messageTs = `${posted.messageId}:${suggestion.id}`;
        return {
          surface: 'telegram' as const,
          kind: 'suggestion_card' as const,
          dedupeKey: `${chatId}:${messageTs}`,
          channelId: chatId,
          messageTs,
          workItemId: suggestion.id,
          createdByUserId,
          metadata: {
            suggestionType: slackConfig.suggestionType,
            suggestionKey: `${sourceTaskId}:${suggestion.id}`,
          },
        };
      }),
    )
    .onConflictDoNothing({
      target: [trackedMessages.kind, trackedMessages.dedupeKey],
    });

  apiLogger.debug(
    `[AutomationSuggestionLifecycle] Published ${limitedSuggestions.length} ${slackConfig.automationKey} suggestions to Telegram chat ${chatId} for sourceTaskId=${sourceTaskId}`,
  );

  return true;
}

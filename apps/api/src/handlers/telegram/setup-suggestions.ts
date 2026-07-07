import type { CommunicationMessageButton } from '@roomote/communication';
import {
  buildSetupSuggestionsInlineIntroText,
  SETUP_SUGGESTIONS_TELEGRAM_START_INSTRUCTION,
} from '@roomote/communication/chat-messages';
import {
  agentSuggestionMessages,
  and,
  db,
  eq,
  isNull,
  like,
  resolveTelegramRuntimeCredentials,
  taskSuggestions,
} from '@roomote/db/server';
import { enqueueTelegramSuggestedTasksOnboardingFollowup } from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import {
  buildInlineSuggestionIdeaLines,
  buildSharedMessageSuggestionRows,
  hasTrackedSetupSuggestionMessages,
  insertSetupSuggestionMessageRows,
  MAX_SETUP_SUGGESTIONS,
  scheduleSuggestedTasksFollowupBestEffort,
  type SetupSuggestionSummary,
} from '../tasks/setup-suggestion-lifecycle.js';
import { findTelegramPrimaryChatId } from './primary-chat.js';
import { postTelegramMessageBestEffort } from './replies.js';

const SUGGESTION_CALLBACK_PREFIX = 'idea:';

function buildTelegramSuggestionCallbackData(suggestionId: string): string {
  return `${SUGGESTION_CALLBACK_PREFIX}${suggestionId}`;
}

export function parseTelegramSuggestionCallbackData(
  data: string,
): string | null {
  if (!data.startsWith(SUGGESTION_CALLBACK_PREFIX)) {
    return null;
  }

  const suggestionId = data.slice(SUGGESTION_CALLBACK_PREFIX.length).trim();

  return suggestionId || null;
}

/**
 * Telegram counterpart of the Slack starter-suggestions intro. Where Slack
 * fans out into a root message plus one reply per idea, Telegram gets a
 * single message with one start button per idea to keep notification noise
 * to one ping (see the noise guardrails in slack-onboarding.md).
 */
export async function postSetupTaskSuggestionsToTelegram(params: {
  sourceTaskId: string;
  createdByUserId: string | null;
  suggestions: SetupSuggestionSummary[];
}): Promise<void> {
  const { sourceTaskId, createdByUserId, suggestions } = params;

  if (!createdByUserId || suggestions.length === 0) {
    return;
  }

  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return;
  }

  const chatId = await findTelegramPrimaryChatId();

  if (!chatId) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] Skip Telegram suggestion post because no primary chat is captured for sourceTaskId=${sourceTaskId}`,
    );
    return;
  }

  if (await hasTrackedSetupSuggestionMessages(sourceTaskId)) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] Skip Telegram suggestion post because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
    );
    return;
  }

  const limitedSuggestions = suggestions.slice(0, MAX_SETUP_SUGGESTIONS);
  const introLines = [
    buildSetupSuggestionsInlineIntroText({
      startInstruction: SETUP_SUGGESTIONS_TELEGRAM_START_INSTRUCTION,
    }),
    '',
    ...buildInlineSuggestionIdeaLines(limitedSuggestions),
  ];
  const buttons: CommunicationMessageButton[][] = limitedSuggestions.map(
    (suggestion, index) => [
      {
        text: `▶️ Start idea ${index + 1}`,
        callbackData: buildTelegramSuggestionCallbackData(suggestion.id),
      },
    ],
  );

  const posted = await postTelegramMessageBestEffort({
    chatId,
    text: introLines.join('\n'),
    textFormat: 'markdown',
    buttons,
  });

  if (!posted) {
    return;
  }

  await insertSetupSuggestionMessageRows(
    buildSharedMessageSuggestionRows({
      messageId: posted.messageId,
      channelId: chatId,
      sourceTaskId,
      createdByUserId,
      suggestions: limitedSuggestions,
    }),
  );

  apiLogger.debug(
    `[SetupSuggestionLifecycle] Published ${limitedSuggestions.length} setup suggestions to Telegram chat ${chatId} for sourceTaskId=${sourceTaskId}`,
  );

  await scheduleSuggestedTasksFollowupBestEffort({
    surfaceLabel: 'Telegram',
    sourceTaskId,
    enqueue: () =>
      enqueueTelegramSuggestedTasksOnboardingFollowup({
        chatId,
        introMessageId: posted.messageId,
        sourceTaskId,
      }),
  });
}

/**
 * Atomically claim a suggestion button click so a double tap cannot launch
 * two tasks. Returns the suggestion to launch, or null when it was already
 * claimed or does not exist.
 */
export async function claimTelegramSuggestionLaunch(input: {
  suggestionId: string;
  chatId: string;
}): Promise<{
  id: string;
  title: string;
  brief: string;
  investigationContext: string | null;
  targetRepositoryFullName: string | null;
} | null> {
  // The chat id scopes the claim; suggestion buttons from any Telegram
  // suggestion surface (setup onboarding, scheduled automations) share the
  // idea:<id> callback and this launch path.
  const [claimed] = await db
    .update(agentSuggestionMessages)
    .set({ launchClaimedAt: new Date() })
    .where(
      and(
        eq(agentSuggestionMessages.channelId, input.chatId),
        like(agentSuggestionMessages.suggestionKey, `%:${input.suggestionId}`),
        isNull(agentSuggestionMessages.launchClaimedAt),
      ),
    )
    .returning({ id: agentSuggestionMessages.id });

  if (!claimed) {
    return null;
  }

  const [suggestion] = await db
    .select({
      id: taskSuggestions.id,
      title: taskSuggestions.title,
      brief: taskSuggestions.brief,
      investigationContext: taskSuggestions.investigationContext,
      targetRepositoryFullName: taskSuggestions.targetRepositoryFullName,
    })
    .from(taskSuggestions)
    .where(eq(taskSuggestions.id, input.suggestionId))
    .limit(1);

  return suggestion ?? null;
}

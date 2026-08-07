import type { CommunicationMessageButton } from '@roomote/communication';
import {
  buildSetupSuggestionsInlineIntroText,
  SETUP_SUGGESTIONS_TELEGRAM_START_INSTRUCTION,
} from '@roomote/communication/chat-messages';
import {
  and,
  claimWorkItem,
  db,
  eq,
  resolveTelegramRuntimeCredentials,
  trackedMessages,
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
import { postTelegramMessageInNewTopicBestEffort } from './replies.js';

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
  const posted = await postTelegramMessageInNewTopicBestEffort({
    chatId,
    topicName: 'Suggested tasks',
    text: introLines.join('\n'),
    textFormat: 'markdown',
    buttons,
  });

  if (!posted) {
    return;
  }

  await insertSetupSuggestionMessageRows(
    buildSharedMessageSuggestionRows({
      surface: 'telegram',
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
        ...(posted.threadId ? { threadId: posted.threadId } : {}),
        introMessageId: posted.messageId,
        sourceTaskId,
      }),
  });
}

/**
 * Atomically claim a suggestion button click so a double tap cannot launch
 * two tasks. Returns the work item to launch, or null when it was already
 * claimed/launched or does not exist. The suggestion id from the `idea:<id>`
 * callback is the backing `work_items` row id; the chat id scopes the claim to
 * a suggestion card actually posted in this Telegram chat.
 *
 * The claim CAS (including its 10-minute stale-claim recovery) lives in the
 * shared `claimWorkItem` helper so every launch surface behaves identically.
 * The returned `launchClaimedAt` is this launcher's fencing token — the caller
 * must thread it through `finalizeWorkItemLaunched`/`releaseWorkItemClaim` so a
 * slow launcher whose claim was reclaimed cannot stomp the new claimant's
 * state.
 */
export async function claimTelegramSuggestionLaunch(input: {
  suggestionId: string;
  chatId: string;
}): Promise<{
  id: string;
  title: string;
  brief: string | null;
  investigationContext: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId?: string | null;
  launchRouting?: 'router' | 'pinned';
  launchClaimedAt: Date;
} | null> {
  // Scope: a suggestion card for this work item must have been posted in this
  // chat. Suggestion buttons from any Telegram suggestion surface (setup
  // onboarding, scheduled automations) share the idea:<id> callback and path.
  const trackedCard = await db.query.trackedMessages.findFirst({
    where: and(
      eq(trackedMessages.kind, 'suggestion_card'),
      eq(trackedMessages.channelId, input.chatId),
      eq(trackedMessages.workItemId, input.suggestionId),
    ),
    columns: { id: true, metadata: true },
  });

  if (!trackedCard) {
    return null;
  }

  const claimed = await claimWorkItem(db, { id: input.suggestionId });

  if (!claimed) {
    return null;
  }

  const launchRouting =
    trackedCard.metadata?.launchRouting === 'router' ||
    typeof trackedCard.metadata?.suggestionGroupKey === 'string'
      ? 'router'
      : 'pinned';

  return {
    id: claimed.id,
    title: claimed.title,
    brief: claimed.brief,
    investigationContext:
      launchRouting === 'pinned' ? claimed.investigationContext : null,
    targetRepositoryFullName:
      launchRouting === 'pinned' ? claimed.targetRepositoryFullName : null,
    targetEnvironmentId:
      launchRouting === 'pinned' ? claimed.targetEnvironmentId : null,
    launchRouting,
    launchClaimedAt: claimed.launchClaimedAt,
  };
}

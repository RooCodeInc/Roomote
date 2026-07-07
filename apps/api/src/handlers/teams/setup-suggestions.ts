import {
  buildSetupSuggestionsInlineIntroText,
  SETUP_SUGGESTIONS_TEAMS_START_INSTRUCTION,
} from '@roomote/communication/chat-messages';
import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';
import { enqueueTeamsSuggestedTasksOnboardingFollowup } from '@roomote/sdk/server';

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
import { findTelegramPrimaryChatId } from '../telegram/primary-chat.js';
import {
  findTeamsPrimaryConversation,
  postTeamsAutomationMessageBestEffort,
} from './automation-messaging.js';

async function hasTelegramOnboardingDestination(): Promise<boolean> {
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return false;
  }

  return Boolean(await findTelegramPrimaryChatId());
}

/**
 * Teams counterpart of the Slack/Telegram starter-suggestions intro, for
 * deployments whose only chat surface is Teams. One markdown message to the
 * primary conversation keeps notification noise to a single ping (see the
 * guardrails in slack-onboarding.md). Teams has no inline start buttons yet,
 * so the intro asks the user to reply with the idea they want.
 */
export async function postSetupTaskSuggestionsToTeams(params: {
  sourceTaskId: string;
  createdByUserId: string | null;
  suggestions: SetupSuggestionSummary[];
}): Promise<void> {
  const { sourceTaskId, createdByUserId, suggestions } = params;

  if (!createdByUserId || suggestions.length === 0) {
    return;
  }

  // Telegram outranks Teams for onboarding output, matching the automation
  // fallback ordering; callers already checked there is no Slack destination.
  if (await hasTelegramOnboardingDestination()) {
    return;
  }

  const conversation = await findTeamsPrimaryConversation();

  if (!conversation) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] Skip Teams suggestion post because no Teams installation is available for sourceTaskId=${sourceTaskId}`,
    );
    return;
  }

  if (await hasTrackedSetupSuggestionMessages(sourceTaskId)) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] Skip Teams suggestion post because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
    );
    return;
  }

  const limitedSuggestions = suggestions.slice(0, MAX_SETUP_SUGGESTIONS);
  const introLines = [
    buildSetupSuggestionsInlineIntroText({
      startInstruction: SETUP_SUGGESTIONS_TEAMS_START_INSTRUCTION,
    }),
    '',
    ...buildInlineSuggestionIdeaLines(limitedSuggestions),
  ];

  const posted = await postTeamsAutomationMessageBestEffort({
    conversationId: conversation.conversationId,
    serviceUrl: conversation.serviceUrl,
    text: introLines.join('\n'),
  });

  if (!posted?.messageId) {
    return;
  }

  const introMessageId = posted.messageId;

  await insertSetupSuggestionMessageRows(
    buildSharedMessageSuggestionRows({
      messageId: introMessageId,
      channelId: conversation.conversationId,
      sourceTaskId,
      createdByUserId,
      suggestions: limitedSuggestions,
    }),
  );

  apiLogger.debug(
    `[SetupSuggestionLifecycle] Published ${limitedSuggestions.length} setup suggestions to Teams conversation ${conversation.conversationId} for sourceTaskId=${sourceTaskId}`,
  );

  await scheduleSuggestedTasksFollowupBestEffort({
    surfaceLabel: 'Teams',
    sourceTaskId,
    enqueue: () =>
      enqueueTeamsSuggestedTasksOnboardingFollowup({
        conversationId: conversation.conversationId,
        serviceUrl: conversation.serviceUrl,
        introMessageId,
        sourceTaskId,
      }),
  });
}

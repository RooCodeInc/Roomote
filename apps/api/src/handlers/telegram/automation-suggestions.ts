import type { CommunicationMessageButton } from '@roomote/communication';
import {
  and,
  db,
  eq,
  getAutomationRuntime,
  getAutomationTelegramTopicThreadId,
  persistAutomationTelegramTopicThread,
  resolveTelegramRuntimeCredentials,
  sql,
  trackedMessages,
} from '@roomote/db/server';
import type { BackgroundAutomationKey } from '@roomote/types';

import { apiLogger } from '../../logging.js';
import { resolveScheduledSuggestionSlackConfig } from '../tasks/background-automation-slack.js';
import { buildScheduledSuggestionRootMessage } from '../tasks/scheduled-suggestion-root-summary.js';
import { findTelegramPrimaryChatId } from './primary-chat.js';
import {
  createTelegramForumTopicBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';

const MAX_TELEGRAM_AUTOMATION_SUGGESTIONS = 5;

/** Sticky forum-topic name for Suggest Ideas recurring delivery. */
export const SUGGEST_IDEAS_TELEGRAM_TOPIC_NAME = 'Suggest Ideas';

type TelegramAutomationSuggestion = {
  id: string;
  title: string;
  brief: string;
  category: string | null;
  targetRepositoryFullName: string | null;
  suggestionNumber?: number;
};

export async function postCurrentThreadSuggestionsToTelegram(params: {
  sourceTaskId: string;
  suggestionGroupKey: string;
  createdByUserId: string | null;
  launchRouting?: 'router';
  chatId: string;
  threadId?: string | null;
  suggestions: TelegramAutomationSuggestion[];
}): Promise<boolean> {
  if (params.suggestions.length === 0) {
    return true;
  }

  for (const [index, suggestion] of params.suggestions.entries()) {
    const buttons: CommunicationMessageButton[][] = [
      [{ text: '▶️ Start', callbackData: `idea:${suggestion.id}` }],
    ];
    const posted = await postTelegramMessageBestEffort({
      chatId: params.chatId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      text: `**${suggestion.suggestionNumber ?? index + 1}. ${suggestion.title}**\n${suggestion.brief}`,
      textFormat: 'markdown',
      buttons,
    });

    if (!posted) {
      return false;
    }

    const trackedRow = {
      surface: 'telegram' as const,
      kind: 'suggestion_card' as const,
      dedupeKey: `${params.chatId}:${posted.messageId}`,
      channelId: params.chatId,
      ...(params.threadId ? { threadTs: params.threadId } : {}),
      messageTs: posted.messageId,
      workItemId: suggestion.id,
      createdByUserId: params.createdByUserId,
      metadata: {
        suggestionType: 'suggested_tasks',
        suggestionKey: `${params.sourceTaskId}:${suggestion.id}`,
        suggestionGroupKey: params.suggestionGroupKey,
        ...(params.launchRouting
          ? { launchRouting: params.launchRouting }
          : {}),
      },
    };
    await db
      .insert(trackedMessages)
      .values(trackedRow)
      .onConflictDoNothing({
        target: [trackedMessages.kind, trackedMessages.dedupeKey],
      });
  }

  return true;
}

async function resolveTelegramSuggestionChatId(
  automationKey: BackgroundAutomationKey,
): Promise<string | null> {
  const runtime = await getAutomationRuntime(automationKey);
  if (runtime.destination?.provider === 'telegram') {
    return runtime.destination.channelId;
  }
  return findTelegramPrimaryChatId();
}

/**
 * Post into an existing sticky topic when present; otherwise create a recurring
 * topic once, persist its thread id, and post there. Falls back to the parent
 * chat when topics are unavailable.
 */
async function postToStickyOrNewTopic(params: {
  automationKey: BackgroundAutomationKey;
  chatId: string;
  stickyTopicName: string;
  text: string;
  buttons: CommunicationMessageButton[][];
}): Promise<{ messageId: string; threadId?: string } | null> {
  const runtime = await getAutomationRuntime(params.automationKey);
  const existingThreadId = getAutomationTelegramTopicThreadId(runtime);

  if (existingThreadId) {
    const reused = await postTelegramMessageBestEffort({
      chatId: params.chatId,
      threadId: existingThreadId,
      text: params.text,
      textFormat: 'markdown',
      buttons: params.buttons,
    });
    if (reused) {
      return { messageId: reused.messageId, threadId: existingThreadId };
    }
    apiLogger.debug(
      `[AutomationSuggestionLifecycle] Sticky Telegram topic ${existingThreadId} failed for ${params.automationKey}; recreating`,
    );
  }

  const topic = await createTelegramForumTopicBestEffort({
    chatId: params.chatId,
    name: params.stickyTopicName,
  });

  if (topic?.threadId) {
    await persistAutomationTelegramTopicThread({
      automationKey: params.automationKey,
      chatId: params.chatId,
      threadId: topic.threadId,
      topicName: params.stickyTopicName,
    });
    const posted = await postTelegramMessageBestEffort({
      chatId: params.chatId,
      threadId: topic.threadId,
      text: params.text,
      textFormat: 'markdown',
      buttons: params.buttons,
    });
    return posted
      ? { messageId: posted.messageId, threadId: topic.threadId }
      : null;
  }

  // Topics unavailable (no Threaded Mode / Manage Topics): post in the chat.
  const fallback = await postTelegramMessageBestEffort({
    chatId: params.chatId,
    text: params.text,
    textFormat: 'markdown',
    buttons: params.buttons,
  });
  return fallback ? { messageId: fallback.messageId } : null;
}

/**
 * Telegram counterpart of the scheduled-automation Slack summaries
 * (suggester, Sentry triage, Dependabot triage, security/code-quality
 * auditors, CI failure triage). Posts one message to the captured primary
 * chat or configured Telegram destination.
 *
 * Suggest Ideas reuses a sticky "Suggest Ideas" forum topic (create once,
 * recreate on failure). Other automations still open a one-shot "Suggested
 * tasks" topic per delivery for backwards compatibility with existing flows.
 *
 * Returns whether the summary was DELIVERED (posted now, or already present
 * from a prior run). Surface precedence is owned by the caller.
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

  const slackConfig = resolveScheduledSuggestionSlackConfig(
    params.suggestionSource,
  );
  const chatId = await resolveTelegramSuggestionChatId(
    slackConfig.automationKey,
  );

  if (!chatId) {
    apiLogger.debug(
      `[AutomationSuggestionLifecycle] Skip Telegram automation summary because no chat is available for sourceTaskId=${sourceTaskId}`,
    );
    return false;
  }

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

  const useStickyTopic = slackConfig.automationKey === 'suggester';
  const posted = useStickyTopic
    ? await postToStickyOrNewTopic({
        automationKey: 'suggester',
        chatId,
        stickyTopicName: SUGGEST_IDEAS_TELEGRAM_TOPIC_NAME,
        text: messageLines.join('\n'),
        buttons,
      })
    : await (async () => {
        const topic = await createTelegramForumTopicBestEffort({
          chatId,
          name: 'Suggested tasks',
        });
        const result = await postTelegramMessageBestEffort({
          chatId,
          ...(topic ? { threadId: topic.threadId } : {}),
          text: messageLines.join('\n'),
          textFormat: 'markdown',
          buttons,
        });
        return result
          ? { messageId: result.messageId, ...(topic ?? {}) }
          : null;
      })();

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
          ...(posted.threadId ? { threadTs: posted.threadId } : {}),
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
    `[AutomationSuggestionLifecycle] Published ${limitedSuggestions.length} ${slackConfig.automationKey} suggestions to Telegram chat ${chatId}${posted.threadId ? ` topic ${posted.threadId}` : ''} for sourceTaskId=${sourceTaskId}`,
  );

  return true;
}

import type { CommunicationMessageButton } from '@roomote/communication';
import { and, db, eq, sql, trackedMessages } from '@roomote/db/server';
import {
  findDiscordAutomationDestination,
  findDiscordDefaultDestination,
} from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import { resolveScheduledSuggestionSlackConfig } from '../tasks/background-automation-slack.js';
import { buildCommunicationTaskThreadName } from '../tasks/communication-task-thread.js';
import { buildScheduledSuggestionRootMessage } from '../tasks/scheduled-suggestion-root-summary.js';
import { resolveDiscordProvider } from './provider.js';

const MAX_DISCORD_AUTOMATION_SUGGESTIONS = 5;
const DISCORD_MAX_INITIAL_POST_LENGTH = 2_000;

type DiscordAutomationSuggestion = {
  id: string;
  title: string;
  brief: string;
  category: string | null;
  targetRepositoryFullName: string | null;
  suggestionNumber?: number;
};

export async function postCurrentThreadSuggestionsToDiscord(params: {
  sourceTaskId: string;
  suggestionGroupKey: string;
  createdByUserId: string | null;
  channelId: string;
  threadId?: string | null;
  suggestions: DiscordAutomationSuggestion[];
}): Promise<boolean> {
  if (params.suggestions.length === 0) {
    return true;
  }

  let provider: Awaited<ReturnType<typeof resolveDiscordProvider>>['provider'];
  try {
    ({ provider } = await resolveDiscordProvider());
  } catch {
    return false;
  }

  for (const [index, suggestion] of params.suggestions.entries()) {
    const posted = await provider.postMessage({
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      text: `**${suggestion.suggestionNumber ?? index + 1}. ${suggestion.title}**\n${suggestion.brief}`,
    });

    if (!posted.messageId) {
      return false;
    }

    const trackedRow = {
      surface: 'discord' as const,
      kind: 'suggestion_card' as const,
      dedupeKey: `${posted.threadId ?? posted.channelId}:${posted.messageId}`,
      channelId: posted.threadId ?? posted.channelId,
      ...(posted.threadId ? { threadTs: posted.threadId } : {}),
      messageTs: posted.messageId,
      workItemId: suggestion.id,
      createdByUserId: params.createdByUserId,
      metadata: {
        suggestionType: 'suggested_tasks',
        suggestionKey: `${params.sourceTaskId}:${suggestion.id}`,
        suggestionGroupKey: params.suggestionGroupKey,
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

function fitDiscordInitialPost(text: string): string {
  if (text.length <= DISCORD_MAX_INITIAL_POST_LENGTH) {
    return text;
  }
  return `${text.slice(0, DISCORD_MAX_INITIAL_POST_LENGTH - 1).trimEnd()}…`;
}

/**
 * Posts a scheduled suggestion summary into a fresh Discord task thread/forum
 * post, with one launch button per suggestion.
 */
export async function postScheduledSuggestionsToDiscord(params: {
  sourceTaskId: string;
  createdByUserId: string | null;
  suggestionSource?: Parameters<
    typeof resolveScheduledSuggestionSlackConfig
  >[0];
  suggestions: DiscordAutomationSuggestion[];
}): Promise<boolean> {
  const { sourceTaskId, createdByUserId, suggestions } = params;
  if (suggestions.length === 0 || !sourceTaskId.trim()) {
    return false;
  }

  const slackConfig = resolveScheduledSuggestionSlackConfig(
    params.suggestionSource,
  );
  // The automation's own Discord channel target wins over the deployment
  // default, mirroring Slack's per-automation channel.
  const destination =
    (await findDiscordAutomationDestination(slackConfig.automationKey)) ??
    (await findDiscordDefaultDestination());
  if (!destination) {
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
      `[AutomationSuggestionLifecycle] Skip Discord automation summary because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
    );
    return true;
  }

  let provider: Awaited<ReturnType<typeof resolveDiscordProvider>>['provider'];
  try {
    ({ provider } = await resolveDiscordProvider());
  } catch {
    return false;
  }

  const rootMessage = await buildScheduledSuggestionRootMessage({
    slackConfig,
    actionFooterText: slackConfig.actionFooterText,
    suggestions,
  });
  const limitedSuggestions = suggestions.slice(
    0,
    MAX_DISCORD_AUTOMATION_SUGGESTIONS,
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
  const thread = await provider.createTaskThread({
    channelId: destination.channelId,
    name: buildCommunicationTaskThreadName('Suggested tasks'),
    initialText: fitDiscordInitialPost(messageLines.join('\n')),
    buttons,
  });

  if (!thread.messageId) {
    return false;
  }

  await db
    .insert(trackedMessages)
    .values(
      limitedSuggestions.map((suggestion) => {
        const messageTs = `${thread.messageId}:${suggestion.id}`;
        return {
          surface: 'discord' as const,
          kind: 'suggestion_card' as const,
          dedupeKey: `${thread.channelId}:${messageTs}`,
          channelId: thread.channelId,
          threadTs: thread.channelId,
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
    `[AutomationSuggestionLifecycle] Published ${limitedSuggestions.length} ${slackConfig.automationKey} suggestions to Discord thread ${thread.channelId} for sourceTaskId=${sourceTaskId}`,
  );
  return true;
}

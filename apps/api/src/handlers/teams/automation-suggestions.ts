import {
  and,
  db,
  environments,
  eq,
  getAutomationRuntime,
  inArray,
  isNotNull,
  sql,
  teamsInstallations,
  trackedMessages,
} from '@roomote/db/server';
import { getScheduledSuggestionBackgroundAutomationDescriptor } from '@roomote/types';
import { Env } from '@roomote/env';

import { apiLogger } from '../../logging.js';
import { resolveScheduledSuggestionSlackConfig } from '../tasks/background-automation-slack.js';
import { buildScheduledSuggestionRootMessage } from '../tasks/scheduled-suggestion-root-summary.js';
import {
  findTeamsPrimaryConversation,
  postTeamsAutomationMessageBestEffort,
} from './automation-messaging.js';

const MAX_TEAMS_AUTOMATION_SUGGESTIONS = 5;

type TeamsAutomationSuggestion = {
  id: string;
  title: string;
  brief: string;
  category: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
};

export async function postCurrentThreadSuggestionsToTeams(params: {
  sourceTaskId: string;
  suggestionGroupKey: string;
  createdByUserId: string | null;
  conversationId: string;
  serviceUrl: string;
  threadId?: string | null;
  suggestions: TeamsAutomationSuggestion[];
}): Promise<boolean> {
  if (params.suggestions.length === 0) {
    return true;
  }

  for (const [index, suggestion] of params.suggestions.entries()) {
    const posted = await postTeamsAutomationMessageBestEffort({
      conversationId: params.conversationId,
      serviceUrl: params.serviceUrl,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      text: `**${index + 1}. ${suggestion.title}**\n${suggestion.brief}`,
    });

    if (!posted?.messageId) {
      return false;
    }

    const trackedRow = {
      surface: 'teams' as const,
      kind: 'suggestion_card' as const,
      dedupeKey: `${params.conversationId}:${posted.messageId}`,
      channelId: params.conversationId,
      ...(params.threadId ? { threadTs: params.threadId } : {}),
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

/**
 * Teams counterpart of the scheduled-automation Slack/Telegram summaries, and
 * the last fallback (Slack > Telegram > Teams). Posts one markdown message to
 * the primary Teams conversation. Teams has no inline start buttons yet, so
 * suggestions link back to the automations page instead.
 *
 * Surface precedence is owned by the caller in submitTaskSuggestions, which
 * only invokes this when neither Slack nor Telegram delivered — this function
 * no longer self-suppresses on Slack/Telegram destination existence.
 */
export async function postScheduledSuggestionsToTeams(params: {
  sourceTaskId: string;
  createdByUserId: string | null;
  suggestionSource?: Parameters<
    typeof resolveScheduledSuggestionSlackConfig
  >[0];
  suggestions: TeamsAutomationSuggestion[];
}): Promise<void> {
  const { sourceTaskId, createdByUserId, suggestions } = params;

  // Automation-initiated scans have no user, so createdByUserId is null. That
  // must not suppress the fallback post; the tracked_messages column is
  // nullable and no user attribution is rendered here.
  if (suggestions.length === 0 || !sourceTaskId.trim()) {
    return;
  }

  const slackConfig = resolveScheduledSuggestionSlackConfig(
    params.suggestionSource,
  );
  const runtime = await getAutomationRuntime(slackConfig.automationKey);
  let conversation =
    runtime.destination?.provider === 'teams'
      ? await (async () => {
          const [row] = await db
            .select({
              conversationId: teamsInstallations.conversationId,
              serviceUrl: teamsInstallations.serviceUrl,
            })
            .from(teamsInstallations)
            .where(
              and(
                eq(
                  teamsInstallations.conversationId,
                  runtime.destination!.channelId,
                ),
                eq(teamsInstallations.isActive, true),
                isNotNull(teamsInstallations.serviceUrl),
              ),
            )
            .limit(1);
          return row?.serviceUrl
            ? {
                conversationId: row.conversationId,
                serviceUrl: row.serviceUrl,
              }
            : null;
        })()
      : null;
  conversation ??= await findTeamsPrimaryConversation();

  if (!conversation) {
    apiLogger.debug(
      `[AutomationSuggestionLifecycle] Skip Teams automation summary because no Teams installation is available for sourceTaskId=${sourceTaskId}`,
    );
    return;
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
      `[AutomationSuggestionLifecycle] Skip Teams automation summary because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
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
    MAX_TEAMS_AUTOMATION_SUGGESTIONS,
  );
  const overflowCount = suggestions.length - limitedSuggestions.length;
  const automationsUrl = new URL('/automations', Env.R_APP_URL).toString();
  const automationLabel =
    getScheduledSuggestionBackgroundAutomationDescriptor(
      params.suggestionSource,
    )?.label ?? null;
  const environmentNamesById =
    await resolveTeamsSuggestionEnvironmentNames(limitedSuggestions);
  const messageLines = [
    rootMessage.summaryText,
    '',
    ...limitedSuggestions.map((suggestion, index) => {
      const lines = [`**${index + 1}. ${suggestion.title}**`, suggestion.brief];
      const bottomLine = buildTeamsSuggestionBottomLine({
        automationLabel,
        environmentName: suggestion.targetEnvironmentId
          ? (environmentNamesById.get(suggestion.targetEnvironmentId) ?? null)
          : null,
      });
      if (bottomLine) {
        lines.push(`_${bottomLine}_`);
      }
      return lines.join('\n');
    }),
    ...(overflowCount > 0
      ? ['', `…and ${overflowCount} more in the task view.`]
      : []),
    '',
    `Start any of these from [Automations](${automationsUrl}).`,
  ];

  const posted = await postTeamsAutomationMessageBestEffort({
    conversationId: conversation.conversationId,
    serviceUrl: conversation.serviceUrl,
    text: messageLines.join('\n'),
  });

  if (!posted?.messageId) {
    return;
  }

  await db
    .insert(trackedMessages)
    .values(
      limitedSuggestions.map((suggestion) => {
        // (kind, dedupeKey) is unique; suffix the suggestion id on messageTs
        // so every tracked row survives the batch insert for a single message.
        const messageTs = `${posted.messageId}:${suggestion.id}`;
        return {
          surface: 'teams' as const,
          kind: 'suggestion_card' as const,
          dedupeKey: `${conversation.conversationId}:${messageTs}`,
          channelId: conversation.conversationId,
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
    `[AutomationSuggestionLifecycle] Published ${limitedSuggestions.length} ${slackConfig.automationKey} suggestions to Teams conversation ${conversation.conversationId} for sourceTaskId=${sourceTaskId}`,
  );
}

async function resolveTeamsSuggestionEnvironmentNames(
  suggestions: TeamsAutomationSuggestion[],
): Promise<Map<string, string>> {
  const targetEnvironmentIds = [
    ...new Set(
      suggestions
        .map((suggestion) => suggestion.targetEnvironmentId)
        .filter(
          (targetEnvironmentId): targetEnvironmentId is string =>
            typeof targetEnvironmentId === 'string' &&
            targetEnvironmentId.length > 0,
        ),
    ),
  ];

  if (targetEnvironmentIds.length === 0) {
    return new Map();
  }

  return new Map(
    (
      await db
        .select({ id: environments.id, name: environments.name })
        .from(environments)
        .where(inArray(environments.id, targetEnvironmentIds))
    ).map((environment) => [environment.id, environment.name]),
  );
}

function buildTeamsSuggestionBottomLine(params: {
  automationLabel: string | null;
  environmentName: string | null;
}): string | null {
  const automationLabel = params.automationLabel?.trim() || null;
  const environmentName = params.environmentName?.trim() || null;

  if (!automationLabel) {
    return null;
  }

  return environmentName
    ? `${automationLabel} in ${environmentName}`
    : automationLabel;
}

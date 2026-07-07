import {
  agentSuggestionMessages,
  and,
  db,
  environments,
  eq,
  inArray,
  like,
  resolveTelegramRuntimeCredentials,
  slackInstallations,
} from '@roomote/db/server';
import { getScheduledSuggestionBackgroundAutomationDescriptor } from '@roomote/types';
import { Env } from '@roomote/env';

import { apiLogger } from '../../logging.js';
import { resolveScheduledSuggestionSlackConfig } from '../tasks/background-automation-slack.js';
import { buildScheduledSuggestionRootMessage } from '../tasks/scheduled-suggestion-root-summary.js';
import { findTelegramPrimaryChatId } from '../telegram/primary-chat.js';
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

async function hasActiveSlackInstallation(): Promise<boolean> {
  const [installation] = await db
    .select({ id: slackInstallations.id })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  return Boolean(installation);
}

async function hasTelegramAutomationDestination(): Promise<boolean> {
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return false;
  }

  return Boolean(await findTelegramPrimaryChatId());
}

/**
 * Teams counterpart of the scheduled-automation Slack/Telegram summaries.
 * Runs only when neither an active Slack installation nor a Telegram
 * automation destination exists (Slack > Telegram > Teams, so output never
 * splits across surfaces), and posts one markdown message to the primary
 * Teams conversation. Teams has no inline start buttons yet, so suggestions
 * link back to the automations page instead.
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

  if (!createdByUserId || suggestions.length === 0 || !sourceTaskId.trim()) {
    return;
  }

  if (await hasActiveSlackInstallation()) {
    return;
  }

  if (await hasTelegramAutomationDestination()) {
    return;
  }

  const conversation = await findTeamsPrimaryConversation();

  if (!conversation) {
    apiLogger.debug(
      `[AutomationSuggestionLifecycle] Skip Teams automation summary because no Teams installation is available for sourceTaskId=${sourceTaskId}`,
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
  const automationsUrl = new URL(
    '/automations',
    Env.ROOMOTE_APP_URL,
  ).toString();
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
    .insert(agentSuggestionMessages)
    .values(
      limitedSuggestions.map((suggestion) => ({
        agentType: slackConfig.agentType,
        // (channelId, messageTs) is unique; suffix the suggestion id so
        // every tracked row survives the batch insert for a single message.
        messageTs: `${posted.messageId}:${suggestion.id}`,
        channelId: conversation.conversationId,
        suggestionKey: `${sourceTaskId}:${suggestion.id}`,
        createdByUserId,
      })),
    )
    .onConflictDoNothing();

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

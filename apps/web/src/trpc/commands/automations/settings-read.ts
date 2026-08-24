import {
  USER_FACING_AUTOMATION_KEYS,
  type BackgroundAutomationKey,
  type PrReviewSettings,
  type TaskTrigger,
  type TaskState,
} from '@roomote/types';
import {
  db,
  desc,
  discordInstallations,
  eq,
  getAutomationRuntimes,
  getBackgroundAgentSettingsForDeployment,
  getBackgroundAgentSettingsWithAutomationsForDeployment,
  inArray,
  resolveTelegramRuntimeCredentials,
  tasks,
  type Automation,
} from '@roomote/db/server';
import {
  findDiscordDestinationByChannelId,
  findTeamsConversationDisplayName,
  findTeamsPrimaryConversation,
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from '@roomote/sdk/server';
import { resolveConfiguredGitHubAppSlug } from '@roomote/github';
import { SlackChannelInfoCache, SlackNotifier } from '@roomote/slack';

import type { UserAuthSuccess } from '@/types';

import { hasActiveSentryIntegration } from './automation-requirements';
import {
  maskSlackChannelAutoStartSettings,
  assertAdmin,
} from './feature-gates';
import {
  buildDefaultReviewerSettings,
  getRelayEligibleCreatorIds,
  listReviewerRelayUserRecords,
  mapReviewerSettingsToBackgroundSettings,
  type ReviewerRelayUser,
} from './reviewer';
import {
  extractSlackBotScopes,
  findActiveSlackInstallationForOrg,
  getSlackChannelAccessWarnings,
  getSlackChannelDisplayNames,
  REQUIRED_BACKGROUND_AGENT_SCOPES,
} from './slack-channels';
import {
  MANAGER_REPORTING_AUTOMATION_KEYS,
  type ResolvedAutomationDestinations,
  type SlackChannelDisplayNames,
} from './types';

/**
 * Automation run history is the tasks the automation launched
 * (tasks.initiator_automation = key). Announcer / manager stats launch no
 * tasks; their history surfaces from the automations row status instead.
 */
type AutomationTaskRunSummary = {
  taskId: string;
  title: string | null;
  trigger: TaskTrigger;
  state: TaskState;
  createdAt: Date;
};

type AutomationStatusSummary = {
  enabled: boolean;
  lastRunAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
};

const RUN_HISTORY_KEYS: BackgroundAutomationKey[] = [
  'conflict_resolver',
  'suggester',
  'announcer',
  'manager_stats',
  'sentry_triage',
  'dependabot_triage',
  'codeql_triage',
  'issue_fixer',
  'security_auditor',
  'code_quality_auditor',
  'ci_failure_triage',
];

const RUN_HISTORY_LIMIT_PER_AUTOMATION = 5;

async function listRecentAutomationTasks(): Promise<
  Partial<Record<BackgroundAutomationKey, AutomationTaskRunSummary[]>>
> {
  const rows = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      trigger: tasks.trigger,
      state: tasks.state,
      createdAt: tasks.createdAt,
      initiatorAutomation: tasks.initiatorAutomation,
    })
    .from(tasks)
    .where(inArray(tasks.initiatorAutomation, RUN_HISTORY_KEYS))
    .orderBy(desc(tasks.createdAt))
    .limit(RUN_HISTORY_KEYS.length * RUN_HISTORY_LIMIT_PER_AUTOMATION * 2);

  const grouped: Partial<
    Record<BackgroundAutomationKey, AutomationTaskRunSummary[]>
  > = {};

  for (const row of rows) {
    const key = row.initiatorAutomation as BackgroundAutomationKey | null;

    if (!key) {
      continue;
    }

    const existing = grouped[key] ?? [];

    if (existing.length >= RUN_HISTORY_LIMIT_PER_AUTOMATION) {
      continue;
    }

    existing.push({
      taskId: row.taskId,
      title: row.title,
      trigger: row.trigger,
      state: row.state,
      createdAt: row.createdAt,
    });
    grouped[key] = existing;
  }

  return grouped;
}

function buildAutomationStatus(
  automationRows: Automation[],
): Partial<Record<BackgroundAutomationKey, AutomationStatusSummary>> {
  const status: Partial<
    Record<BackgroundAutomationKey, AutomationStatusSummary>
  > = {};

  for (const automation of automationRows) {
    if (
      !(USER_FACING_AUTOMATION_KEYS as readonly string[]).includes(
        automation.key,
      )
    ) {
      continue;
    }

    status[automation.key] = {
      enabled: automation.enabled,
      lastRunAt: automation.lastRunAt,
      lastSucceededAt: automation.lastSucceededAt,
      lastFailedAt: automation.lastFailedAt,
      lastError: automation.lastError,
    };
  }

  return status;
}

async function resolveDestinationDisplayName(
  destination: ResolvedAutomationDestination,
  notifier: SlackNotifier | null,
): Promise<string | null> {
  if (destination.provider === 'slack') {
    const channelName = notifier
      ? await notifier.getChannelName(destination.channelId)
      : null;

    return channelName ? `#${channelName}` : null;
  }

  if (destination.provider === 'teams') {
    return findTeamsConversationDisplayName(destination.channelId);
  }

  if (destination.provider === 'discord') {
    const discordDestination = await findDiscordDestinationByChannelId(
      destination.channelId,
    );

    // Null falls back to showing the raw channel id in the UI.
    return discordDestination?.channelName
      ? `#${discordDestination.channelName}`
      : null;
  }

  if (destination.provider === 'telegram') {
    return 'Telegram · Suggest Ideas topic';
  }

  // Telegram chats have no reliable display name; the UI shows the chat id.
  return null;
}

/**
 * Resolves, per manager-reporting automation, where its next run will report
 * (destination waterfall: own target -> Manager Channel -> primary
 * conversation) so the settings page can show a "Reports to" line.
 */
async function resolveAutomationDestinations(params: {
  slackConnected: boolean;
  notifier: SlackNotifier | null;
}): Promise<ResolvedAutomationDestinations> {
  // One batched read for every reporting automation instead of a runtime
  // lookup (plus its deployment_settings read) per key.
  const runtimes = await getAutomationRuntimes(
    MANAGER_REPORTING_AUTOMATION_KEYS,
  );

  const entries = await Promise.all(
    MANAGER_REPORTING_AUTOMATION_KEYS.map(async (key) => {
      const runtime = runtimes[key];
      // Platform issue alerts use deployment-admin DMs as their final tail;
      // unlike scheduled automations, they never post to a primary channel.
      const destination =
        key === 'platform_issue_alerts'
          ? runtime.destination
          : await resolveAutomationRuntimeDestination({
              runtime,
              slackConnected: params.slackConnected,
            });

      if (!destination) {
        return [key, null] as const;
      }

      return [
        key,
        {
          provider: destination.provider,
          channelId: destination.channelId,
          source: destination.source,
          displayName: await resolveDestinationDisplayName(
            destination,
            params.notifier,
          ),
        },
      ] as const;
    }),
  );

  return Object.fromEntries(entries) as ResolvedAutomationDestinations;
}

export async function getBackgroundAgentSettingsCommand(
  auth: UserAuthSuccess,
): Promise<{
  settings: Awaited<ReturnType<typeof getBackgroundAgentSettingsForDeployment>>;
  reviewer: {
    id: string;
    enabled: boolean;
    environmentScope: NonNullable<PrReviewSettings['environmentScope']>;
    environmentIds: string[];
    authorReviewMode: NonNullable<PrReviewSettings['authorReviewMode']>;
    collaboratorLogins: string[];
    excludedAuthors: string | null;
    reviewAllPullRequestAuthors: boolean;
    reviewOnCommit: boolean;
    reviewDraftPrs: boolean;
    relayReviewResultsToTask: boolean;
    relayUsers: ReviewerRelayUser[];
    approvePr: boolean;
  };
  capabilities: {
    slackConnected: boolean;
    discordConnected: boolean;
    telegramConnected: boolean;
    teamsConnected: boolean;
    sentryConnected: boolean;
    missingScopes: readonly string[];
    requiredScopes: string[];
    requiresSlackReconnect: boolean;
    slackWorkspaceDomain: string | null;
  };
  slackChannelAccessWarnings: {
    channelAutoStartSlackChannels: string[];
    managerStatsSlackChannel: string | null;
    suggesterSlackChannel: string | null;
    announcerSlackChannel: string | null;
    platformIssueSlackChannel: string | null;
    sentryTriageSlackChannel: string | null;
    dependabotTriageSlackChannel: string | null;
    codeqlTriageSlackChannel: string | null;
    securityAuditorSlackChannel: string | null;
    codeQualityAuditorSlackChannel: string | null;
    ciFailureTriageSlackChannel: string | null;
  };
  slackChannelDisplayNames: SlackChannelDisplayNames;
  resolvedDestinations: ResolvedAutomationDestinations;
  recentRuns: Partial<
    Record<BackgroundAutomationKey, AutomationTaskRunSummary[]>
  >;
  automationStatus: Partial<
    Record<BackgroundAutomationKey, AutomationStatusSummary>
  >;
}> {
  assertAdmin(auth);

  const [
    { settings, automationRows },
    slackInstallation,
    discordInstallation,
    telegramCredentials,
    teamsPrimaryConversation,
    sentryConnected,
    recentRuns,
  ] = await Promise.all([
    getBackgroundAgentSettingsWithAutomationsForDeployment(),
    findActiveSlackInstallationForOrg(),
    db.query.discordInstallations.findFirst({
      where: eq(discordInstallations.isActive, true),
      columns: { id: true },
    }),
    resolveTelegramRuntimeCredentials(),
    findTeamsPrimaryConversation(),
    hasActiveSentryIntegration(),
    listRecentAutomationTasks(),
  ]);
  const status = buildAutomationStatus(automationRows);
  const visibleSettings = maskSlackChannelAutoStartSettings(auth, settings);

  const botScopes = extractSlackBotScopes(slackInstallation?.scopes).map(
    (scope) => scope.toLowerCase(),
  );
  const grantedScopes = new Set(botScopes);

  const missingScopes = slackInstallation
    ? REQUIRED_BACKGROUND_AGENT_SCOPES.filter(
        (scope) => !grantedScopes.has(scope),
      )
    : [];
  // Request-scoped memo (backed by the shared Redis cache) so the warning and
  // display-name passes resolve each channel through Slack at most once.
  const notifier = slackInstallation
    ? new SlackNotifier(slackInstallation.botAccessToken, {
        channelInfoCache: new SlackChannelInfoCache(slackInstallation.teamId),
      })
    : null;
  const [
    relayUsers,
    slackChannelAccessWarnings,
    slackChannelDisplayNames,
    resolvedDestinations,
  ] = await Promise.all([
    listReviewerRelayUserRecords(
      auth,
      getRelayEligibleCreatorIds(settings.reviewCodeSettings),
    ),
    getSlackChannelAccessWarnings({
      notifier,
      channelAutoStartSlackChannelIds:
        visibleSettings.channelAutoStartSlackChannels.map(
          ({ channelId }) => channelId,
        ),
      managerStatsSlackChannelId: visibleSettings.managerStatsSlackChannelId,
      suggesterSlackChannelId: visibleSettings.suggesterSlackChannelId,
      announcerSlackChannelId: visibleSettings.announcerSlackChannelId,
      platformIssueSlackChannelId: visibleSettings.platformIssueSlackChannelId,
      sentryTriageSlackChannelId: visibleSettings.sentryTriageSlackChannelId,
      dependabotTriageSlackChannelId:
        visibleSettings.dependabotTriageSlackChannelId,
      codeqlTriageSlackChannelId: visibleSettings.codeqlTriageSlackChannelId,
      securityAuditorSlackChannelId:
        visibleSettings.securityAuditorSlackChannelId,
      codeQualityAuditorSlackChannelId:
        visibleSettings.codeQualityAuditorSlackChannelId,
      ciFailureTriageSlackChannelId:
        visibleSettings.ciFailureTriageSlackChannelId,
    }),
    getSlackChannelDisplayNames({
      notifier,
      channelAutoStartSlackChannelIds:
        visibleSettings.channelAutoStartSlackChannels.map(
          ({ channelId }) => channelId,
        ),
      managerSlackChannelId: visibleSettings.managerSlackChannelId,
      managerStatsSlackChannelId: visibleSettings.managerStatsSlackChannelId,
      suggesterSlackChannelId: visibleSettings.suggesterSlackChannelId,
      announcerSlackChannelId: visibleSettings.announcerSlackChannelId,
      platformIssueSlackChannelId: visibleSettings.platformIssueSlackChannelId,
      sentryTriageSlackChannelId: visibleSettings.sentryTriageSlackChannelId,
      dependabotTriageSlackChannelId:
        visibleSettings.dependabotTriageSlackChannelId,
      codeqlTriageSlackChannelId: visibleSettings.codeqlTriageSlackChannelId,
      securityAuditorSlackChannelId:
        visibleSettings.securityAuditorSlackChannelId,
      codeQualityAuditorSlackChannelId:
        visibleSettings.codeQualityAuditorSlackChannelId,
      ciFailureTriageSlackChannelId:
        visibleSettings.ciFailureTriageSlackChannelId,
    }),
    resolveAutomationDestinations({
      slackConnected: Boolean(slackInstallation?.isActive),
      notifier,
    }),
  ]);

  // The reviewer mapping derives its managed-login list synchronously from
  // the cached configured app slug.
  await resolveConfiguredGitHubAppSlug();

  return {
    settings: visibleSettings,
    reviewer: settings.reviewCodeSettings
      ? mapReviewerSettingsToBackgroundSettings(
          settings.reviewCodeSettings,
          relayUsers,
        )
      : buildDefaultReviewerSettings(relayUsers),
    capabilities: {
      slackConnected: Boolean(slackInstallation?.isActive),
      discordConnected: Boolean(discordInstallation),
      telegramConnected: Boolean(telegramCredentials.botToken),
      teamsConnected: Boolean(teamsPrimaryConversation),
      sentryConnected,
      missingScopes,
      requiredScopes: [...REQUIRED_BACKGROUND_AGENT_SCOPES],
      requiresSlackReconnect: missingScopes.length > 0,
      slackWorkspaceDomain: slackInstallation?.isActive
        ? slackInstallation.teamDomain
        : null,
    },
    slackChannelAccessWarnings,
    slackChannelDisplayNames,
    resolvedDestinations,
    recentRuns,
    automationStatus: status,
  };
}

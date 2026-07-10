import {
  USER_FACING_AUTOMATION_KEYS,
  type BackgroundAutomationKey,
  type PrReviewerSettings,
  type TaskTrigger,
  type TaskState,
} from '@roomote/types';
import {
  db,
  desc,
  getBackgroundAgentSettingsForDeployment,
  inArray,
  listAutomations,
  tasks,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';

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
import type { SlackChannelDisplayNames } from './types';

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

async function buildAutomationStatus(): Promise<
  Partial<Record<BackgroundAutomationKey, AutomationStatusSummary>>
> {
  const automationRows = await listAutomations();
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

export async function getBackgroundAgentSettingsCommand(
  auth: UserAuthSuccess,
): Promise<{
  settings: Awaited<ReturnType<typeof getBackgroundAgentSettingsForDeployment>>;
  reviewer: {
    id: string;
    enabled: boolean;
    environmentScope: NonNullable<PrReviewerSettings['environmentScope']>;
    environmentIds: string[];
    authorReviewMode: NonNullable<PrReviewerSettings['authorReviewMode']>;
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
    securityAuditorSlackChannel: string | null;
    codeQualityAuditorSlackChannel: string | null;
    ciFailureTriageSlackChannel: string | null;
  };
  slackChannelDisplayNames: SlackChannelDisplayNames;
  recentRuns: Partial<
    Record<BackgroundAutomationKey, AutomationTaskRunSummary[]>
  >;
  automationStatus: Partial<
    Record<BackgroundAutomationKey, AutomationStatusSummary>
  >;
}> {
  assertAdmin(auth);

  const [settings, slackInstallation, sentryConnected, recentRuns, status] =
    await Promise.all([
      getBackgroundAgentSettingsForDeployment(),
      findActiveSlackInstallationForOrg(),
      hasActiveSentryIntegration(),
      listRecentAutomationTasks(),
      buildAutomationStatus(),
    ]);
  const relayUsers = await listReviewerRelayUserRecords(
    auth,
    getRelayEligibleCreatorIds(settings.reviewCodeSettings),
  );
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
  const notifier = slackInstallation
    ? new SlackNotifier(slackInstallation.botAccessToken)
    : null;
  const slackChannelAccessWarnings = await getSlackChannelAccessWarnings({
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
    securityAuditorSlackChannelId:
      visibleSettings.securityAuditorSlackChannelId,
    codeQualityAuditorSlackChannelId:
      visibleSettings.codeQualityAuditorSlackChannelId,
    ciFailureTriageSlackChannelId:
      visibleSettings.ciFailureTriageSlackChannelId,
  });
  const slackChannelDisplayNames = await getSlackChannelDisplayNames({
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
    securityAuditorSlackChannelId:
      visibleSettings.securityAuditorSlackChannelId,
    codeQualityAuditorSlackChannelId:
      visibleSettings.codeQualityAuditorSlackChannelId,
    ciFailureTriageSlackChannelId:
      visibleSettings.ciFailureTriageSlackChannelId,
  });

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
    recentRuns,
    automationStatus: status,
  };
}

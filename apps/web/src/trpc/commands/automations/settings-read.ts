import {
  type BackgroundAutomationKey,
  type PrReviewerSettings,
} from '@roomote/types';
import {
  getBackgroundAgentSettingsForDeployment,
  listRecentBackgroundAutomationRuns,
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

type BackgroundAutomationRunSummary = Awaited<
  ReturnType<typeof listRecentBackgroundAutomationRuns>
>[number];

function groupRecentRunsByAutomation(
  runs: BackgroundAutomationRunSummary[],
  limitPerAutomation = 5,
): Partial<Record<BackgroundAutomationKey, BackgroundAutomationRunSummary[]>> {
  const grouped: Partial<
    Record<BackgroundAutomationKey, BackgroundAutomationRunSummary[]>
  > = {};

  for (const run of runs) {
    const existing = grouped[run.automationKey] ?? [];

    if (existing.length >= limitPerAutomation) {
      continue;
    }

    existing.push(run);
    grouped[run.automationKey] = existing;
  }

  return grouped;
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
    coachSlackChannel: string | null;
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
    Record<BackgroundAutomationKey, BackgroundAutomationRunSummary[]>
  >;
}> {
  assertAdmin(auth);

  const [settings, slackInstallation, sentryConnected, recentRuns] =
    await Promise.all([
      getBackgroundAgentSettingsForDeployment(),
      findActiveSlackInstallationForOrg(),
      hasActiveSentryIntegration(),
      listRecentBackgroundAutomationRuns({
        automationKeys: [
          'conflict_resolver',
          'coach',
          'suggester',
          'announcer',
          'manager_stats',
          'sentry_triage',
          'dependabot_triage',
          'security_auditor',
          'code_quality_auditor',
        ],
        limit: 40,
      }),
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
    coachSlackChannelId: visibleSettings.coachSlackChannelId,
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
    managerStatsSlackChannelId: visibleSettings.managerStatsSlackChannelId,
    coachSlackChannelId: visibleSettings.coachSlackChannelId,
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
    recentRuns: groupRecentRunsByAutomation(recentRuns),
  };
}

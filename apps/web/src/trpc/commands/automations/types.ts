import type {
  AnnouncerFrequency,
  BackgroundAutomationKey,
  ChannelAutoStartLaunchMode,
  CommunicationProvider,
  ConflictResolverMaxPrAgeDays,
  ConflictResolverFrequency,
  DependabotTriageFrequency,
  CodeqlTriageFrequency,
  ManagerStatsFrequency,
  PrReviewSettings,
  ScheduleOnlyBackgroundAutomationFrequency,
  ScheduleOnlyBackgroundAutomationFrequencyField,
  ScheduleOnlyBackgroundAutomationId,
  SentryTriageFrequency,
  SuggesterFrequency,
} from '@roomote/types';

export type BackgroundAgentFieldErrorKey =
  | 'general'
  | 'reviewerEnvironmentIds'
  | 'reviewerCollaborators'
  | 'reviewerExcludedAuthors'
  | 'conflictResolverLabel'
  | 'conflictResolverMaxPrAgeDays'
  | 'conflictResolverInstructions'
  | 'channelAutoStartSlackChannels'
  | 'channelAutoStartDiscordChannels'
  | 'channelAutoStartInstructions'
  | 'channelAutoStartLaunchCriteria'
  | 'managerSlackChannel'
  | 'managerDiscordChannel'
  | 'managerTeamsChannel'
  | 'managerTelegramChannel'
  | 'managerStatsSlackChannel'
  | 'suggesterSlackChannel'
  | 'announcerSlackChannel'
  | 'platformIssueSlackChannel'
  | 'sentryTriageSlackChannel'
  | 'dependabotTriageSlackChannel'
  | 'codeqlTriageSlackChannel'
  | 'securityAuditorSlackChannel'
  | 'codeQualityAuditorSlackChannel'
  | 'ciFailureTriageSlackChannel'
  | 'managerStatsDiscordChannel'
  | 'sentryTriageDiscordChannel'
  | 'dependabotTriageDiscordChannel'
  | 'codeqlTriageDiscordChannel'
  | 'securityAuditorDiscordChannel'
  | 'codeQualityAuditorDiscordChannel'
  | 'ciFailureTriageDiscordChannel'
  | 'suggesterDiscordChannel'
  | 'announcerDiscordChannel'
  | 'platformIssueDiscordChannel'
  | 'suggesterUseTelegram'
  | 'suggesterUseTeams'
  | 'sentryTriageProjectSlugs'
  | 'suggesterInstructions'
  | 'announcerInstructions'
  | 'reviewerInstructions'
  | 'issueFixerInstructions';

export type BackgroundAgentFieldErrors = Partial<
  Record<BackgroundAgentFieldErrorKey, string>
>;

export type SlackChannelFieldErrorKey = Extract<
  BackgroundAgentFieldErrorKey,
  | 'channelAutoStartSlackChannels'
  | 'managerSlackChannel'
  | 'managerStatsSlackChannel'
  | 'suggesterSlackChannel'
  | 'announcerSlackChannel'
  | 'platformIssueSlackChannel'
  | 'sentryTriageSlackChannel'
  | 'dependabotTriageSlackChannel'
  | 'codeqlTriageSlackChannel'
  | 'securityAuditorSlackChannel'
  | 'codeQualityAuditorSlackChannel'
  | 'ciFailureTriageSlackChannel'
>;

export type DiscordChannelFieldErrorKey = Extract<
  BackgroundAgentFieldErrorKey,
  | 'managerDiscordChannel'
  | 'managerStatsDiscordChannel'
  | 'sentryTriageDiscordChannel'
  | 'dependabotTriageDiscordChannel'
  | 'codeqlTriageDiscordChannel'
  | 'securityAuditorDiscordChannel'
  | 'codeQualityAuditorDiscordChannel'
  | 'ciFailureTriageDiscordChannel'
  | 'suggesterDiscordChannel'
  | 'announcerDiscordChannel'
  | 'platformIssueDiscordChannel'
>;

/** A Discord channel the automations destination picker can target. */
export type AutomationDiscordChannelOption = {
  id: string;
  name: string;
  label: string;
  guildId: string;
  guildName: string | null;
};

export interface SlackChannelAccessWarnings {
  channelAutoStartSlackChannels: string[];
  managerSlackChannel: string | null;
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
}

export interface SlackChannelDisplayNames {
  channelAutoStartSlackChannels: Record<string, string | null>;
  managerSlackChannel: string | null;
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
}

/**
 * Automations whose reports flow through the manager-channel destination
 * waterfall (own target -> Manager Channel -> primary conversation).
 * platform_issue_alerts delivery only walks the first two levels (own
 * target -> Manager Channel); it is included so the settings page can show
 * its "Reports to" line.
 */
export const MANAGER_REPORTING_AUTOMATION_KEYS = [
  'manager_stats',
  'sentry_triage',
  'dependabot_triage',
  'codeql_triage',
  'security_auditor',
  'code_quality_auditor',
  'ci_failure_triage',
  'suggester',
  'announcer',
  'platform_issue_alerts',
] as const satisfies readonly BackgroundAutomationKey[];

export type ManagerReportingAutomationKey =
  (typeof MANAGER_REPORTING_AUTOMATION_KEYS)[number];

/**
 * Where an automation's next run will report, resolved through the runtime
 * destination waterfall, plus which waterfall level produced it and a
 * human-readable channel name when one is resolvable.
 */
export interface ResolvedAutomationDestinationSummary {
  provider: CommunicationProvider;
  channelId: string;
  source: 'automation_target' | 'manager_channel' | 'primary_conversation';
  /** e.g. "#eng-managers" (Slack) or a Teams channel/team name; null when unknown. */
  displayName: string | null;
}

export type ResolvedAutomationDestinations = Record<
  ManagerReportingAutomationKey,
  ResolvedAutomationDestinationSummary | null
>;

export interface ChannelAutoStartInputRow {
  // Canonical Slack channel ID persisted for this row. When present and valid it
  // is used as the resolution input so an unchanged row never has to be
  // re-resolved by name on save. Null/absent for new or channel-edited rows.
  channelId?: string | null;
  slackChannel: string | null;
  instructions: string | null;
  launchMode?: ChannelAutoStartLaunchMode | null;
  launchCriteria?: string | null;
}

/**
 * Discord auto-respond rows always carry the catalog channel id directly (the
 * picker only offers cataloged channels), so there is no name-resolution
 * variant of this shape.
 */
export interface ChannelAutoStartDiscordInputRow {
  channelId: string | null;
  instructions: string | null;
  launchMode?: ChannelAutoStartLaunchMode | null;
  launchCriteria?: string | null;
}

type ScheduleOnlyAutomationInputFields = Partial<
  Record<
    ScheduleOnlyBackgroundAutomationFrequencyField,
    ScheduleOnlyBackgroundAutomationFrequency
  >
>;

export interface ResolvedChannelAutoStartRow {
  channelId: string;
  channelName: string | null;
  instructions: string | null;
  launchMode: ChannelAutoStartLaunchMode;
  launchCriteria: string | null;
}

export interface ResolvedChannelAutoStartDiscordRow {
  channelId: string;
  instructions: string | null;
  launchMode: ChannelAutoStartLaunchMode;
  launchCriteria: string | null;
}

export interface UpdateBackgroundAgentSettingsInput extends ScheduleOnlyAutomationInputFields {
  savingAutomation:
    | 'channelAutoStart'
    | 'managerChannel'
    | 'managerStats'
    | 'reviewer'
    | 'conflictResolver'
    | 'suggester'
    | 'sentryTriage'
    | 'dependabotTriage'
    | 'codeqlTriage'
    | ScheduleOnlyBackgroundAutomationId
    | 'announcer'
    | 'platformIssueAlerts';
  reviewerEnabled: boolean;
  reviewerEnvironmentScope: NonNullable<PrReviewSettings['environmentScope']>;
  reviewerEnvironmentIds: string[];
  reviewerAuthorReviewMode: NonNullable<PrReviewSettings['authorReviewMode']>;
  reviewerCollaborators: string[];
  reviewerExcludedAuthors: string | null;
  reviewerReviewAllPullRequestAuthors: boolean;
  reviewerReviewOnCommit: boolean;
  reviewerReviewDraftPrs: boolean;
  reviewerInstructions?: string | null;
  reviewerRelayReviewResultsToTask: boolean;
  reviewerRelayUserIds: string[];
  conflictResolverFrequency: ConflictResolverFrequency;
  conflictResolverMaxPrAgeDays?: ConflictResolverMaxPrAgeDays;
  conflictResolverLabel: string;
  conflictResolverInstructions: string | null;
  issueFixerInstructions?: string | null;
  channelAutoStartSlackChannels?: ChannelAutoStartInputRow[];
  /**
   * Optional with no default: older clients never send it, and their saves
   * must preserve persisted Discord auto-respond targets untouched.
   */
  channelAutoStartDiscordChannels?: ChannelAutoStartDiscordInputRow[];
  channelAutoStartEnabled?: boolean;
  channelAutoStartSlackChannel?: string | null;
  channelAutoStartInstructions?: string | null;
  managerSlackChannel?: string | null;
  managerDiscordChannel?: string | null;
  managerTeamsChannel?: string | null;
  managerTelegramChannel?: string | null;
  managerStatsFrequency?: ManagerStatsFrequency;
  managerStatsSlackChannel?: string | null;
  managerStatsDiscordChannel?: string | null;
  sentryTriageFrequency?: SentryTriageFrequency;
  sentryTriageSlackChannel?: string | null;
  sentryTriageDiscordChannel?: string | null;
  sentryTriageProjectSlugs?: string | null;
  dependabotTriageFrequency?: DependabotTriageFrequency;
  dependabotTriageSlackChannel?: string | null;
  dependabotTriageDiscordChannel?: string | null;
  codeqlTriageFrequency?: CodeqlTriageFrequency;
  codeqlTriageSlackChannel?: string | null;
  codeqlTriageDiscordChannel?: string | null;
  suggesterFrequency: SuggesterFrequency;
  suggesterSlackChannel: string | null;
  suggesterDiscordChannel?: string | null;
  /** When true, Suggest Ideas delivers to a sticky Telegram topic. */
  suggesterUseTelegram?: boolean;
  /** When true, Suggest Ideas delivers to the primary Teams conversation. */
  suggesterUseTeams?: boolean;
  suggesterInstructions: string | null;
  announcerFrequency: AnnouncerFrequency;
  announcerSlackChannel: string | null;
  announcerDiscordChannel?: string | null;
  announcerInstructions: string | null;
  platformIssueSlackChannel: string | null;
  platformIssueDiscordChannel?: string | null;
  securityAuditorSlackChannel?: string | null;
  securityAuditorDiscordChannel?: string | null;
  codeQualityAuditorSlackChannel?: string | null;
  codeQualityAuditorDiscordChannel?: string | null;
  ciFailureTriageSlackChannel?: string | null;
  ciFailureTriageDiscordChannel?: string | null;
}

import type {
  AnnouncerFrequency,
  ChannelAutoStartLaunchMode,
  ConflictResolverMaxPrAgeDays,
  ConflictResolverFrequency,
  DependabotTriageFrequency,
  ManagerStatsFrequency,
  PrReviewSettings,
  ScheduleOnlyBackgroundAutomationFrequency,
  ScheduleOnlyBackgroundAutomationFrequencyField,
  ScheduleOnlyBackgroundAutomationId,
  SentryTriageFrequency,
  SuggesterFrequency,
  SuggesterRoutingMode,
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
  | 'channelAutoStartInstructions'
  | 'channelAutoStartLaunchCriteria'
  | 'managerSlackChannel'
  | 'managerStatsSlackChannel'
  | 'suggesterSlackChannel'
  | 'announcerSlackChannel'
  | 'platformIssueSlackChannel'
  | 'sentryTriageSlackChannel'
  | 'dependabotTriageSlackChannel'
  | 'securityAuditorSlackChannel'
  | 'codeQualityAuditorSlackChannel'
  | 'ciFailureTriageSlackChannel'
  | 'sentryTriageProjectSlugs'
  | 'suggesterInstructions'
  | 'suggesterRoutingInstructions'
  | 'announcerInstructions';

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
  | 'securityAuditorSlackChannel'
  | 'codeQualityAuditorSlackChannel'
  | 'ciFailureTriageSlackChannel'
>;

export interface SlackChannelAccessWarnings {
  channelAutoStartSlackChannels: string[];
  managerSlackChannel: string | null;
  managerStatsSlackChannel: string | null;
  suggesterSlackChannel: string | null;
  announcerSlackChannel: string | null;
  platformIssueSlackChannel: string | null;
  sentryTriageSlackChannel: string | null;
  dependabotTriageSlackChannel: string | null;
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
  securityAuditorSlackChannel: string | null;
  codeQualityAuditorSlackChannel: string | null;
  ciFailureTriageSlackChannel: string | null;
}

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
  reviewerRelayReviewResultsToTask: boolean;
  reviewerRelayUserIds: string[];
  conflictResolverFrequency: ConflictResolverFrequency;
  conflictResolverMaxPrAgeDays?: ConflictResolverMaxPrAgeDays;
  conflictResolverLabel: string;
  conflictResolverInstructions: string | null;
  channelAutoStartSlackChannels?: ChannelAutoStartInputRow[];
  channelAutoStartEnabled?: boolean;
  channelAutoStartSlackChannel?: string | null;
  channelAutoStartInstructions?: string | null;
  managerSlackChannel?: string | null;
  managerStatsFrequency?: ManagerStatsFrequency;
  managerStatsSlackChannel?: string | null;
  sentryTriageFrequency?: SentryTriageFrequency;
  sentryTriageSlackChannel?: string | null;
  sentryTriageProjectSlugs?: string | null;
  dependabotTriageFrequency?: DependabotTriageFrequency;
  dependabotTriageSlackChannel?: string | null;
  suggesterFrequency: SuggesterFrequency;
  suggesterSlackChannel: string | null;
  suggesterInstructions: string | null;
  suggesterRoutingMode?: SuggesterRoutingMode;
  suggesterRoutingInstructions?: string | null;
  announcerFrequency: AnnouncerFrequency;
  announcerSlackChannel: string | null;
  announcerInstructions: string | null;
  platformIssueSlackChannel: string | null;
  securityAuditorSlackChannel?: string | null;
  codeQualityAuditorSlackChannel?: string | null;
  ciFailureTriageSlackChannel?: string | null;
}

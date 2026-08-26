import type {
  AnnouncerFrequency,
  AutomationScanCursor,
  ChannelAutoStartLaunchMode,
  CiFailureTriageFrequency,
  CodeQualityAuditorFrequency,
  ConflictResolverFrequency,
  ConflictResolverMaxPrAgeDays,
  CodeqlTriageFrequency,
  DependabotTriageFrequency,
  IssueFixerFrequency,
  ManagerStatsFrequency,
  ProviderUsageLimitFrequency,
  ProviderUsageLimitThreshold,
  PrReviewSettings,
  SecurityAuditorFrequency,
  SentryTriageFrequency,
  SuggesterFrequency,
} from '@roomote/types';

import type {
  users,
  deploymentSettings,
  tasks,
  taskPins,
  taskPullRequests,
  taskRuns,
  taskRunEvents,
  taskStartParallelCounts,
  workItems,
  taskMessages,
  llmUsageEvents,
  taskSlackReplyDetails,
  taskPlatformIssueReports,
  githubPendingInstallations,
  githubInstallations,
  pullRequestFacts,
  pullRequestSyncStates,
  repositories,
  slackAuthTokens,
  fastAgentConversations,
  fastAgentMessages,
  fastAgentProviderMessages,
  slackInstallations,
  slackInstallationChannels,
  slackUserMappings,
  discordInstallations,
  discordInstallationChannels,
  discordUserMappings,
  discordGatewaySessions,
  teamsInstallations,
  teamsUserMappings,
  slackFastIntegrationCalls,
  linearPendingSelections,
  environmentVariables,
  environments,
  environmentConfigVersions,
  environmentRepositoryMappings,
  automations,
  customAutomations,
  trackedMessages,
} from './schema';

type Timestamp = 'createdAt' | 'updatedAt';

type Generated = 'id' | Timestamp;

/**
 * users
 */

export type User = typeof users.$inferSelect;

export type CreateUser = Omit<typeof users.$inferInsert, Timestamp>;

/**
 * deploymentSettings
 */

export type DeploymentSettings = typeof deploymentSettings.$inferSelect;

export type CreateDeploymentSettings = Omit<
  typeof deploymentSettings.$inferInsert,
  Timestamp
>;

/**
 * tasks
 */

export type Task = typeof tasks.$inferSelect;

export type CreateTask = typeof tasks.$inferInsert;

/**
 * taskPins
 */

export type TaskPin = typeof taskPins.$inferSelect;

export type CreateTaskPin = Omit<typeof taskPins.$inferInsert, Generated>;

/**
 * taskPullRequests
 */

export type TaskPullRequest = typeof taskPullRequests.$inferSelect;

/**
 * taskRuns
 */

export type TaskRun = typeof taskRuns.$inferSelect;

export type CreateTaskRun = Omit<typeof taskRuns.$inferInsert, Generated>;

export type UpdateTaskRun = Partial<Omit<TaskRun, 'id' | 'createdAt'>>;

/**
 * taskRunEvents
 */

export type TaskRunEvent = typeof taskRunEvents.$inferSelect;

export type CreateTaskRunEvent = Omit<
  typeof taskRunEvents.$inferInsert,
  Generated
>;

/**
 * task_start_parallel_counts
 */

export type TaskStartParallelCount =
  typeof taskStartParallelCounts.$inferSelect;

export type CreateTaskStartParallelCount = Omit<
  typeof taskStartParallelCounts.$inferInsert,
  Generated
>;

/**
 * llm_usage_events
 */

export type LlmUsageEvent = typeof llmUsageEvents.$inferSelect;

export type CreateLlmUsageEvent = Omit<
  typeof llmUsageEvents.$inferInsert,
  Generated
>;

/** @deprecated Use LlmUsageEvent. */
export type TaskInferenceUsageEvent = LlmUsageEvent;
/** @deprecated Use CreateLlmUsageEvent. */
export type CreateTaskInferenceUsageEvent = CreateLlmUsageEvent;

/**
 * workItems (Stage 4 merge of task_suggestions + automation_work_items +
 * setup_new_queued_tasks)
 */

export type WorkItem = typeof workItems.$inferSelect;

export type CreateWorkItem = Omit<typeof workItems.$inferInsert, Generated>;

/**
 * taskMessages
 */

export type TaskMessage = typeof taskMessages.$inferSelect;

export type CreateTaskMessage = Omit<
  typeof taskMessages.$inferInsert,
  Generated
>;

/**
 * task_slack_reply_details
 */

export type TaskSlackReplyDetail = typeof taskSlackReplyDetails.$inferSelect;

export type CreateTaskSlackReplyDetail = Omit<
  typeof taskSlackReplyDetails.$inferInsert,
  'createdAt'
>;

/**
 * task_platform_issue_reports
 */

export type TaskPlatformIssueReport =
  typeof taskPlatformIssueReports.$inferSelect;

export type CreateTaskPlatformIssueReport = Omit<
  typeof taskPlatformIssueReports.$inferInsert,
  Generated
>;

/**
 * githubPendingInstallations
 */

export type GitHubPendingInstallation =
  typeof githubPendingInstallations.$inferSelect;

export type CreateGitHubPendingInstallation = Omit<
  typeof githubPendingInstallations.$inferInsert,
  Generated
>;

/**
 * githubInstallations
 */

export type GitHubInstallation = typeof githubInstallations.$inferSelect;

export type CreateGitHubInstallation = Omit<
  typeof githubInstallations.$inferInsert,
  Generated
>;

/**
 * pullRequestFacts
 */

export type PullRequestFact = typeof pullRequestFacts.$inferSelect;

export type CreatePullRequestFact = Omit<
  typeof pullRequestFacts.$inferInsert,
  Generated | 'firstSeenAt' | 'syncedAt'
>;

/**
 * pullRequestSyncStates
 */

export type PullRequestSyncState = typeof pullRequestSyncStates.$inferSelect;

export type CreatePullRequestSyncState = Omit<
  typeof pullRequestSyncStates.$inferInsert,
  Generated
>;

/**
 * repositories
 */

export type Repository = typeof repositories.$inferSelect;

export type CreateRepository = Omit<
  typeof repositories.$inferInsert,
  Generated
>;

/**
 * slackAuthTokens
 */

export type SlackAuthToken = typeof slackAuthTokens.$inferSelect;

export type CreateSlackAuthToken = Omit<
  typeof slackAuthTokens.$inferInsert,
  Generated
>;

/**
 * Provider-neutral Fast conversation persistence.
 */

export type FastAgentConversationRecord =
  typeof fastAgentConversations.$inferSelect;

export type CreateFastAgentConversationRecord = Omit<
  typeof fastAgentConversations.$inferInsert,
  Generated
>;

export type FastAgentMessage = typeof fastAgentMessages.$inferSelect;

export type CreateFastAgentMessage = Omit<
  typeof fastAgentMessages.$inferInsert,
  Generated
>;

export type FastAgentProviderMessage =
  typeof fastAgentProviderMessages.$inferSelect;

export type CreateFastAgentProviderMessage = Omit<
  typeof fastAgentProviderMessages.$inferInsert,
  Generated
>;

/**
 * slackFastIntegrationCalls
 */

export type SlackFastIntegrationCall =
  typeof slackFastIntegrationCalls.$inferSelect;

export type CreateSlackFastIntegrationCall = Omit<
  typeof slackFastIntegrationCalls.$inferInsert,
  Generated
>;

/**
 * slackInstallations
 */

export type SlackInstallation = typeof slackInstallations.$inferSelect;

export type CreateSlackInstallation = Omit<
  typeof slackInstallations.$inferInsert,
  Generated
>;

/**
 * slackInstallationChannels
 */

export type SlackInstallationChannel =
  typeof slackInstallationChannels.$inferSelect;

export type CreateSlackInstallationChannel = Omit<
  typeof slackInstallationChannels.$inferInsert,
  Generated
>;

/**
 * slackUserMappings
 */

export type SlackUserMapping = typeof slackUserMappings.$inferSelect;

export type CreateSlackUserMapping = Omit<
  typeof slackUserMappings.$inferInsert,
  Generated
>;

/**
 * Discord communication state
 */

export type DiscordInstallation = typeof discordInstallations.$inferSelect;
export type CreateDiscordInstallation = Omit<
  typeof discordInstallations.$inferInsert,
  Generated
>;

export type DiscordInstallationChannel =
  typeof discordInstallationChannels.$inferSelect;
export type CreateDiscordInstallationChannel = Omit<
  typeof discordInstallationChannels.$inferInsert,
  Generated
>;

export type DiscordUserMapping = typeof discordUserMappings.$inferSelect;
export type CreateDiscordUserMapping = Omit<
  typeof discordUserMappings.$inferInsert,
  Generated
>;

export type DiscordGatewaySession = typeof discordGatewaySessions.$inferSelect;
export type CreateDiscordGatewaySession = Omit<
  typeof discordGatewaySessions.$inferInsert,
  Timestamp
>;

/**
 * teamsInstallations
 */

export type TeamsInstallation = typeof teamsInstallations.$inferSelect;

export type CreateTeamsInstallation = Omit<
  typeof teamsInstallations.$inferInsert,
  Generated
>;

/**
 * teamsUserMappings
 */

export type TeamsUserMapping = typeof teamsUserMappings.$inferSelect;

export type CreateTeamsUserMapping = Omit<
  typeof teamsUserMappings.$inferInsert,
  Generated
>;

/**
 * trackedMessages (Stage 4 merge of agent_suggestion_messages +
 * background_automation_slack_threads + mcp_setup_manager_notifications)
 */

export type TrackedMessage = typeof trackedMessages.$inferSelect;

export type CreateTrackedMessage = Omit<
  typeof trackedMessages.$inferInsert,
  Generated
>;

/**
 * environmentVariables
 */

export type EnvironmentVariable = typeof environmentVariables.$inferSelect;

export type CreateEnvironmentVariable = Omit<
  typeof environmentVariables.$inferInsert,
  Generated
>;

/**
 * environments
 */

export type Environment = typeof environments.$inferSelect;

export type CreateEnvironment = Omit<
  typeof environments.$inferInsert,
  Generated
>;

export type EnvironmentConfigVersion =
  typeof environmentConfigVersions.$inferSelect;

export type CreateEnvironmentConfigVersion = Omit<
  typeof environmentConfigVersions.$inferInsert,
  Generated
>;

/**
 * environmentRepositoryMappings
 */

export type EnvironmentRepositoryMapping =
  typeof environmentRepositoryMappings.$inferSelect;

export type CreateEnvironmentRepositoryMapping = Omit<
  typeof environmentRepositoryMappings.$inferInsert,
  Generated
>;

/**
 * linearPendingSelections
 */

export type LinearPendingSelection =
  typeof linearPendingSelections.$inferSelect;

export type CreateLinearPendingSelection = Omit<
  typeof linearPendingSelections.$inferInsert,
  Generated
>;

/**
 * backgroundAgentSettings
 *
 * The stored columns live on deployment_settings and hold deployment-wide
 * agent settings (manager channel and global instructions).
 * The flat settings view consumed across the product adds a per-automation
 * projection built from the automations table.
 */

type StoredBackgroundAgentSettings = Pick<
  typeof deploymentSettings.$inferSelect,
  | 'id'
  | 'managerSlackChannelId'
  | 'managerDiscordChannelId'
  | 'globalAgentInstructions'
  | 'timeZone'
  | 'timeZoneUpdatedAt'
  | 'createdAt'
  | 'updatedAt'
>;

export type ChannelAutoStartChannelSettings = {
  channelId: string;
  instructions: string | null;
  launchMode: ChannelAutoStartLaunchMode;
  launchCriteria: string | null;
};

export type BackgroundAgentSettings = StoredBackgroundAgentSettings & {
  callRoomoteViaEmojiEnabled: boolean;
  callRoomoteViaEmojiName: string | null;
  callRoomoteViaEmojiInstructions: string | null;
  channelAutoStartSlackChannels: ChannelAutoStartChannelSettings[];
  channelAutoStartDiscordChannels: ChannelAutoStartChannelSettings[];
  channelAutoStartEnabled: boolean;
  channelAutoStartSlackChannelIds: string[];
  channelAutoStartDiscordChannelIds: string[];
  channelAutoStartInstructions: string | null;
  reviewCodeSettings: PrReviewSettings;
  reviewCodeInstructions: string | null;
  conflictResolverFrequency: ConflictResolverFrequency;
  conflictResolverLabel: string;
  conflictResolverInstructions: string | null;
  conflictResolverMaxPrAgeDays: ConflictResolverMaxPrAgeDays;
  conflictResolverLastRunAt: Date | null;
  suggesterFrequency: SuggesterFrequency;
  suggesterSlackChannelId: string | null;
  suggesterDiscordChannelId: string | null;
  /** Primary Telegram chat id when Suggest Ideas posts to a sticky topic. */
  suggesterTelegramChatId: string | null;
  /** Primary Teams conversation id when Suggest Ideas posts to Teams. */
  suggesterTeamsChannelId: string | null;
  suggesterInstructions: string | null;
  suggesterLastRunAt: Date | null;
  announcerFrequency: AnnouncerFrequency;
  announcerSlackChannelId: string | null;
  announcerDiscordChannelId: string | null;
  announcerInstructions: string | null;
  announcerLastRunAt: Date | null;
  platformIssueAlertsEnabled: boolean;
  platformIssueSlackChannelId: string | null;
  platformIssueDiscordChannelId: string | null;
  managerStatsFrequency: ManagerStatsFrequency;
  managerStatsSlackChannelId: string | null;
  managerStatsDiscordChannelId: string | null;
  managerStatsLastRunAt: Date | null;
  providerUsageLimitFrequency: ProviderUsageLimitFrequency;
  providerUsageLimitThreshold: ProviderUsageLimitThreshold;
  providerUsageLimitSlackChannelId: string | null;
  providerUsageLimitDiscordChannelId: string | null;
  providerUsageLimitLastRunAt: Date | null;
  sentryTriageFrequency: SentryTriageFrequency;
  sentryTriageSlackChannelId: string | null;
  sentryTriageDiscordChannelId: string | null;
  sentryTriageProjectSlugs: string | null;
  sentryTriageLastRunAt: Date | null;
  dependabotTriageFrequency: DependabotTriageFrequency;
  dependabotTriageSlackChannelId: string | null;
  dependabotTriageDiscordChannelId: string | null;
  dependabotTriageLastRunAt: Date | null;
  codeqlTriageFrequency: CodeqlTriageFrequency;
  codeqlTriageSlackChannelId: string | null;
  codeqlTriageDiscordChannelId: string | null;
  codeqlTriageLastRunAt: Date | null;
  issueFixerFrequency: IssueFixerFrequency;
  issueFixerInstructions: string | null;
  issueFixerLastRunAt: Date | null;
  issueFixerScanCursor?: CiFailureTriageScanCursor | null;
  securityAuditorFrequency: SecurityAuditorFrequency;
  securityAuditorSlackChannelId: string | null;
  securityAuditorDiscordChannelId: string | null;
  securityAuditorLastRunAt: Date | null;
  securityAuditorScanCursor?: SecurityAuditorScanCursor | null;
  codeQualityAuditorFrequency: CodeQualityAuditorFrequency;
  codeQualityAuditorSlackChannelId: string | null;
  codeQualityAuditorDiscordChannelId: string | null;
  codeQualityAuditorLastRunAt: Date | null;
  codeQualityAuditorScanCursor?: CodeQualityAuditorScanCursor | null;
  ciFailureTriageFrequency: CiFailureTriageFrequency;
  ciFailureTriageSlackChannelId: string | null;
  ciFailureTriageDiscordChannelId: string | null;
  ciFailureTriageLastRunAt: Date | null;
  ciFailureTriageScanCursor?: CiFailureTriageScanCursor | null;
};

export type SecurityAuditorScanCursor = AutomationScanCursor;

export type CodeQualityAuditorScanCursor = SecurityAuditorScanCursor;

export type CiFailureTriageScanCursor = SecurityAuditorScanCursor;

/**
 * automations
 */

export type Automation = typeof automations.$inferSelect;

export type CreateAutomation = Omit<typeof automations.$inferInsert, Timestamp>;

/**
 * custom_automations
 */

export type CustomAutomation = typeof customAutomations.$inferSelect;

export type CreateCustomAutomation = Omit<
  typeof customAutomations.$inferInsert,
  Timestamp
>;

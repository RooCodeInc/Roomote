import type {
  AnnouncerFrequency,
  AutomationScanCursor,
  ChannelAutoStartLaunchMode,
  CiFailureTriageFrequency,
  CodeQualityAuditorFrequency,
  ConflictResolverFrequency,
  ConflictResolverMaxPrAgeDays,
  DependabotTriageFrequency,
  ManagerStatsFrequency,
  PrReviewerSettings,
  SecurityAuditorFrequency,
  SentryTriageFrequency,
  SuggesterFrequency,
  SuggesterRoutingMode,
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
  taskInferenceUsageEvents,
  taskSlackReplyDetails,
  taskPlatformIssueReports,
  githubPendingInstallations,
  githubInstallations,
  pullRequestFacts,
  pullRequestSyncStates,
  repositories,
  slackAuthTokens,
  slackInstallations,
  slackInstallationChannels,
  slackUserMappings,
  teamsInstallations,
  teamsUserMappings,
  slackQuickAnswers,
  linearPendingSelections,
  environmentVariables,
  environments,
  environmentConfigVersions,
  environmentRepositoryMappings,
  automations,
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
 * task_inference_usage_events
 */

export type TaskInferenceUsageEvent =
  typeof taskInferenceUsageEvents.$inferSelect;

export type CreateTaskInferenceUsageEvent = Omit<
  typeof taskInferenceUsageEvents.$inferInsert,
  Generated
>;

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
 * slackQuickAnswers (renamed from fastAgentSessions in Stage 4)
 */

export type SlackQuickAnswer = typeof slackQuickAnswers.$inferSelect;

export type CreateSlackQuickAnswer = Omit<
  typeof slackQuickAnswers.$inferInsert,
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
 * agent settings (manager channel, global instructions, style guidance,
 * authorship rules, Slack emoji preferences). The flat settings view consumed
 * across the product adds a per-automation projection built from the
 * automations table.
 */

type StoredBackgroundAgentSettings = Pick<
  typeof deploymentSettings.$inferSelect,
  | 'id'
  | 'managerSlackChannelId'
  | 'globalAgentInstructions'
  | 'authorshipInstructions'
  | 'compiledAuthorshipRules'
  | 'compiledAuthorshipIssues'
  | 'compiledAuthorshipAt'
  | 'styleGuidance'
  | 'slackSummonEmoji'
  | 'slackAckEmoji'
  | 'slackCompletionEmoji'
  | 'createdAt'
  | 'updatedAt'
>;

export type BackgroundAgentSettings = StoredBackgroundAgentSettings & {
  channelAutoStartSlackChannels: Array<{
    channelId: string;
    instructions: string | null;
    launchMode: ChannelAutoStartLaunchMode;
    launchCriteria: string | null;
  }>;
  channelAutoStartEnabled: boolean;
  channelAutoStartSlackChannelIds: string[];
  channelAutoStartInstructions: string | null;
  reviewCodeSettings: PrReviewerSettings;
  conflictResolverFrequency: ConflictResolverFrequency;
  conflictResolverLabel: string;
  conflictResolverInstructions: string | null;
  conflictResolverMaxPrAgeDays: ConflictResolverMaxPrAgeDays;
  conflictResolverLastRunAt: Date | null;
  suggesterFrequency: SuggesterFrequency;
  suggesterSlackChannelId: string | null;
  suggesterInstructions: string | null;
  suggesterRoutingMode: SuggesterRoutingMode;
  suggesterRoutingInstructions: string | null;
  suggesterLastRunAt: Date | null;
  announcerFrequency: AnnouncerFrequency;
  announcerSlackChannelId: string | null;
  announcerInstructions: string | null;
  announcerLastRunAt: Date | null;
  platformIssueSlackChannelId: string | null;
  managerStatsFrequency: ManagerStatsFrequency;
  managerStatsSlackChannelId: string | null;
  managerStatsLastRunAt: Date | null;
  sentryTriageFrequency: SentryTriageFrequency;
  sentryTriageSlackChannelId: string | null;
  sentryTriageProjectSlugs: string | null;
  sentryTriageLastRunAt: Date | null;
  dependabotTriageFrequency: DependabotTriageFrequency;
  dependabotTriageSlackChannelId: string | null;
  dependabotTriageLastRunAt: Date | null;
  securityAuditorFrequency: SecurityAuditorFrequency;
  securityAuditorSlackChannelId: string | null;
  securityAuditorLastRunAt: Date | null;
  securityAuditorScanCursor?: SecurityAuditorScanCursor | null;
  codeQualityAuditorFrequency: CodeQualityAuditorFrequency;
  codeQualityAuditorSlackChannelId: string | null;
  codeQualityAuditorLastRunAt: Date | null;
  codeQualityAuditorScanCursor?: CodeQualityAuditorScanCursor | null;
  ciFailureTriageFrequency: CiFailureTriageFrequency;
  ciFailureTriageSlackChannelId: string | null;
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

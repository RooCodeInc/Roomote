import type {
  DependabotTriageFrequency,
  ChannelAutoStartLaunchMode,
  CiFailureTriageFrequency,
  CodeQualityAuditorFrequency,
  ConflictResolverMaxPrAgeDays,
  PrReviewerSettings,
  SecurityAuditorFrequency,
  SentryTriageFrequency,
  SuggesterRoutingMode,
} from '@roomote/types';

import type {
  users,
  deploymentSettings,
  tasks,
  taskPins,
  taskShares,
  taskPullRequests,
  taskRuns,
  taskRunEvents,
  taskStartParallelCounts,
  taskSuggestions,
  automationWorkItems,
  setupNewQueuedTasks,
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
  fastAgentSessions,
  linearPendingSelections,
  environmentVariables,
  environments,
  environmentConfigVersions,
  environmentRepositoryMappings,
  backgroundAgentSettings,
  backgroundAutomations,
  backgroundAutomationTargets,
  backgroundAutomationRuns,
  backgroundAutomationSlackThreads,
  mcpSetupManagerNotifications,
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
 * taskShares
 */

export type TaskShare = typeof taskShares.$inferSelect;

export type CreateTaskShare = Omit<typeof taskShares.$inferInsert, Generated>;

/**
 * taskPullRequests
 */

export type TaskPullRequest = typeof taskPullRequests.$inferSelect;

/**
 * taskRuns
 */

export type Run = typeof taskRuns.$inferSelect;

export type CreateRun = Omit<typeof taskRuns.$inferInsert, Generated>;

export type UpdateRun = Partial<Omit<Run, 'id' | 'createdAt'>>;

// TODO(stage5-rename): temporary type-only aliases to bound downstream churn
// until the Stage 5 CloudJob -> Run vocabulary pass. Do not alias tables.
export type CloudJob = Run;

export type CreateCloudJob = CreateRun;

export type UpdateCloudJob = UpdateRun;

/**
 * taskRunEvents
 */

export type RunEvent = typeof taskRunEvents.$inferSelect;

export type CreateRunEvent = Omit<typeof taskRunEvents.$inferInsert, Generated>;

// TODO(stage5-rename): temporary type-only aliases, see above.
export type CloudJobEvent = RunEvent;

export type CreateCloudJobEvent = CreateRunEvent;

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
 * taskSuggestions
 */

export type TaskSuggestion = typeof taskSuggestions.$inferSelect;

export type CreateTaskSuggestion = Omit<
  typeof taskSuggestions.$inferInsert,
  Generated
>;

/**
 * automationWorkItems
 */

export type AutomationWorkItem = typeof automationWorkItems.$inferSelect;

export type CreateAutomationWorkItem = Omit<
  typeof automationWorkItems.$inferInsert,
  Generated
>;

/**
 * setupNewQueuedTasks
 */

export type SetupNewQueuedTask = typeof setupNewQueuedTasks.$inferSelect;

export type CreateSetupNewQueuedTask = Omit<
  typeof setupNewQueuedTasks.$inferInsert,
  Generated
>;

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
 * fastAgentSessions
 */

export type FastAgentSession = typeof fastAgentSessions.$inferSelect;

export type CreateFastAgentSession = Omit<
  typeof fastAgentSessions.$inferInsert,
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
 * deployment_mcp_setup_manager_notifications
 */

export type DeploymentMcpSetupManagerNotification =
  typeof mcpSetupManagerNotifications.$inferSelect;

export type CreateDeploymentMcpSetupManagerNotification = Omit<
  typeof mcpSetupManagerNotifications.$inferInsert,
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
 */

export type BackgroundAgentSettings =
  typeof backgroundAgentSettings.$inferSelect & {
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
    managerStatsSlackChannelId: string | null;
    conflictResolverMaxPrAgeDays: ConflictResolverMaxPrAgeDays;
    sentryTriageFrequency: SentryTriageFrequency;
    sentryTriageSlackChannelId: string | null;
    sentryTriageProjectSlugs: string | null;
    sentryTriageLastRunAt: Date | null;
    dependabotTriageFrequency: DependabotTriageFrequency;
    dependabotTriageSlackChannelId: string | null;
    dependabotTriageLastRunAt: Date | null;
    suggesterRoutingMode: SuggesterRoutingMode;
    suggesterRoutingInstructions: string | null;
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

export type SecurityAuditorScanCursor = {
  mergedAt: string;
  externalPullRequestId: number;
};

export type CodeQualityAuditorScanCursor = SecurityAuditorScanCursor;

export type CiFailureTriageScanCursor = SecurityAuditorScanCursor;

export type CreateBackgroundAgentSettings = Omit<
  typeof backgroundAgentSettings.$inferInsert,
  Generated
>;

/**
 * backgroundAutomations
 */

export type BackgroundAutomation = typeof backgroundAutomations.$inferSelect;

export type CreateBackgroundAutomation = Omit<
  typeof backgroundAutomations.$inferInsert,
  Generated
>;

/**
 * backgroundAutomationTargets
 */

export type BackgroundAutomationTarget =
  typeof backgroundAutomationTargets.$inferSelect;

export type CreateBackgroundAutomationTarget = Omit<
  typeof backgroundAutomationTargets.$inferInsert,
  Generated
>;

/**
 * backgroundAutomationSlackThreads
 */

export type BackgroundAutomationSlackThread =
  typeof backgroundAutomationSlackThreads.$inferSelect;

export type CreateBackgroundAutomationSlackThread = Omit<
  typeof backgroundAutomationSlackThreads.$inferInsert,
  Generated
>;

/**
 * backgroundAutomationRuns
 */

export type BackgroundAutomationRun =
  typeof backgroundAutomationRuns.$inferSelect;

export type CreateBackgroundAutomationRun = Omit<
  typeof backgroundAutomationRuns.$inferInsert,
  Generated
>;

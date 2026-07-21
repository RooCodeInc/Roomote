export {
  type AppRouter,
  type AppRouterInput,
  type AppRouterOutput,
  appRouter,
} from './routers/app';

export {
  type Context,
  router,
  authenticatedProcedure,
  optionalAuthProcedure,
} from './trpc';

export { finishRun } from './lib/task-runs/finish-run';
export {
  recordLlmUsage,
  type RecordLlmUsageInput,
} from './lib/task-runs/record-task-inference-usage';
export { findTaskRunByRunTokenClaims } from './lib/task-runs/find-task-run';
export { createSnapshot } from './lib/task-runs/enqueue-snapshot';
export {
  enqueueTaskSleep,
  TASK_SLEEP_QUEUE_NAME,
  taskSleepRequestSchema,
  type TaskSleepRequest,
} from './lib/task-runs/enqueue-sleep';
export { recordComputeProviderUsage } from './lib/task-runs/record-compute-provider-usage';
export {
  recordTaskMessageEnvelope,
  refreshTaskTitleOnCompletion,
} from './lib/task-runs/record-task-message-envelope';
export { ensureSnapshotResumeGitHubFollowUpFallback } from './lib/task-runs/ensure-snapshot-resume-github-follow-up-fallback';
export * from './lib/manager-slack';
export * from './automations';
export * from './lib/manager-stats';
export {
  cleanupSandboxOidcTargetsForTaskRun,
  primeSandboxOidcTargets,
  refreshDueSandboxOidcTargets,
} from './lib/sandbox-oidc';
export {
  stampTaskRunMilestone,
  taskRunMilestoneFields,
  type TaskRunMilestoneField,
} from './lib/task-runs/stamp-milestone';

export {
  ARTIFACT_RAW_URL_CLOCK_SKEW_SECONDS,
  ARTIFACT_RAW_URL_MAX_AGE_SECONDS,
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
  isArtifactSignatureTimestampValid,
  signArtifactIdWithKey,
  verifyArtifactSignatureWithKeys,
} from './lib/artifacts/raw-url';
export { createTaskArtifactRecord } from './lib/artifacts/create-record';

export {
  SLACK_ACCOUNT_LINK_EDUCATION_DELAY_MS,
  SLACK_ACCOUNT_LINK_EDUCATION_QUEUE_NAME,
  enqueueSlackAccountLinkEducation,
  enqueueSlackAccountLinkEducationInputSchema,
  slackAccountLinkEducationRequestSchema,
  type EnqueueSlackAccountLinkEducationInput,
  type EnqueueSlackAccountLinkEducationResult,
  type SlackAccountLinkEducationRequest,
} from './lib/slack-account-link-education';

export {
  DISCORD_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_DELAY_MS,
  SLACK_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  TEAMS_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  TELEGRAM_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  discordSuggestedTasksOnboardingFollowupRequestSchema,
  enqueueDiscordSuggestedTasksOnboardingFollowup,
  enqueueSlackSuggestedTasksOnboardingFollowup,
  enqueueTeamsSuggestedTasksOnboardingFollowup,
  enqueueTelegramSuggestedTasksOnboardingFollowup,
  slackSuggestedTasksOnboardingFollowupRequestSchema,
  teamsSuggestedTasksOnboardingFollowupRequestSchema,
  telegramSuggestedTasksOnboardingFollowupRequestSchema,
  type DiscordSuggestedTasksOnboardingFollowupRequest,
  type EnqueueSuggestedTasksOnboardingFollowupResult,
  type SlackSuggestedTasksOnboardingFollowupRequest,
  type TeamsSuggestedTasksOnboardingFollowupRequest,
  type TelegramSuggestedTasksOnboardingFollowupRequest,
} from './lib/suggested-tasks-onboarding-followup';

export {
  TELEGRAM_LINK_CODE_TTL_SECONDS,
  consumeTelegramLinkCode,
  createTelegramLinkCode,
  isTelegramLinkCode,
  restoreTelegramLinkCode,
} from './lib/telegram-link-codes';

export {
  DISCORD_LINK_CODE_TTL_SECONDS,
  consumeDiscordLinkCode,
  createDiscordLinkCode,
  isDiscordLinkCode,
  restoreDiscordLinkCode,
} from './lib/discord-link-codes';

export {
  captureDiscordDefaultDestination,
  clearDiscordGatewayResumeState,
  deactivateDiscordInstallation,
  findDiscordAutomationDestination,
  findDiscordDefaultDestination,
  findDiscordDestinationByChannelId,
  findDiscordGatewayResumeState,
  findDiscordInstallationByGuildId,
  findDiscordMappedUserId,
  findDiscordUserMappingByRoomoteUserId,
  listDiscordInstallationChannels,
  listDiscordInstallations,
  reconcileDiscordInstallations,
  recordDiscordGatewayHeartbeatAck,
  saveDiscordGatewayResumeState,
  syncDiscordInstallationChannels,
  updateDiscordGatewaySequence,
  upsertDiscordInstallation,
  upsertDiscordUserMapping,
  type DiscordDefaultDestination,
  type DiscordGatewayResumeState,
  type DiscordGatewaySessionKey,
  type DiscordInstallationChannelInput,
  type DiscordInstallationReconciliationInput,
  type DiscordInstallationReconciliationResult,
  type DiscordInstallationUpsert,
} from './lib/discord-persistence';

export { createDiscordCommunicationProviderFromRuntimeCredentials } from './lib/discord-communication';

export { createTeamsCommunicationProviderFromRuntimeCredentials } from './lib/teams-communication';

export { createTelegramCommunicationProviderFromRuntimeCredentials } from './lib/telegram-communication';

export { syncTaskCommunicationThreadTitleBestEffort } from './lib/task-thread-title-sync';

export { getCommunicationProviderAdapter } from './lib/communication-providers';

export {
  findTelegramPrimaryChatId,
  TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME,
} from './lib/telegram-primary-chat';

export {
  findTeamsPrimaryConversation,
  type TeamsPrimaryConversation,
} from './lib/teams-primary-conversation';

export {
  sendUserDirectMessageBestEffort,
  type UserDirectMessageProvider,
} from './lib/user-direct-message';

export {
  SLACK_PR_INACTIVITY_DELAY_MS,
  SLACK_PR_INACTIVITY_QUEUE_NAME,
  enqueueSlackPrInactivityCheck,
  enqueueSlackPrInactivityCheckInputSchema,
  fetchPullRequestSnapshotForTaskRun,
  hasPullRequestMoved,
  isPullRequestTerminal,
  pullRequestActivitySnapshotSchema,
  slackPrInactivityCheckRequestSchema,
  type EnqueueSlackPrInactivityCheckInput,
  type PullRequestActivitySnapshot,
  type SlackPrInactivityCheckRequest,
} from './lib/task-runs/slack-pr-inactivity-check';

export {
  PR_REVIEW_NOTIFICATION_DEFER_MS,
  PR_REVIEW_NOTIFICATION_MAX_DEFERRALS,
  PR_REVIEW_NOTIFICATION_QUEUE_NAME,
  consumePendingPrReviewActivity,
  enqueuePrReviewNotification,
  enqueuePrReviewNotificationInputSchema,
  formatPrReviewActivityMessage,
  hasPrReviewNotificationThreadContext,
  prReviewActivityEventSchema,
  prReviewNotificationRequestSchema,
  requeuePendingPrReviewActivity,
  resolvePrReviewNotificationRoute,
  schedulePrReviewNotificationJob,
  type EnqueuePrReviewNotificationInput,
  type PrReviewActivityEvent,
  type PrReviewNotificationRequest,
  type PrReviewNotificationRoute,
} from './lib/task-runs/pr-review-notification';
export {
  gatherPrReviewTriageContext,
  preparePrReviewNotificationDelivery,
  recordPrReviewNotificationDeliveryBestEffort,
  triagePrReviewActivity,
  type PreparedPrReviewNotification,
  type PrReviewTriageContext,
} from './lib/task-runs/pr-review-notification-delivery';

export {
  formatPrStatusChangeTaskHistoryText,
  formatPullRequestReference,
  recordPrStatusChangeInTaskHistory,
  recordPrStatusChangeInTaskHistoryInputSchema,
  type RecordPrStatusChangeInTaskHistoryInput,
} from './lib/task-runs/record-pr-status-change';

export { resolveSlackTaskRunRouting } from './lib/task-runs/slack-task-run-routing';

export {
  findSlackConversationSubjectByUserId,
  recordSlackConversationMessage,
  recordSlackConversationMessageBestEffort,
  type SlackConversationLogInput,
} from './lib/slack-conversation-log';

export { updateTaskPrStatus } from './lib/pull-requests/update-task-pr-status';
export {
  manageSourceControlIssueForTaskRun,
  sourceControlIssueInputSchema,
  SourceControlIssueError,
  type SourceControlIssueCommentWriteResult,
  type SourceControlIssueCommentsResult,
  type SourceControlIssueDetailsResult,
  type SourceControlIssueInput,
  type SourceControlIssueResult,
} from './lib/issues/source-control-issues';
export {
  createOrUpdateSourceControlPullRequestForTaskRun,
  findTaskRunForSourceControlMutation,
  sourceControlPullRequestMutationInputSchema,
  SourceControlMutationError,
  type SourceControlPullRequestMutationInput,
  type SourceControlPullRequestMutationResult,
} from './lib/pull-requests/source-control-pull-requests';
export {
  readSourceControlPullRequestForTaskRun,
  sourceControlPullRequestReadInputSchema,
  SourceControlReadError,
  type SourceControlPullRequestReadInput,
  type SourceControlPullRequestDetailsResult,
  type SourceControlPullRequestCommentsResult,
  type SourceControlPullRequestListResult,
  type SourceControlPullRequestSummary,
} from './lib/pull-requests/source-control-pull-request-reads';
export {
  writeSourceControlPullRequestForTaskRun,
  sourceControlPullRequestWriteInputSchema,
  SourceControlWriteError,
  type SourceControlPullRequestWriteInput,
  type SourceControlPullRequestWriteResult,
} from './lib/pull-requests/source-control-pull-request-writes';
export {
  syncGitHubPullRequestFactsForAllOrgs,
  syncGitHubPullRequestFactsForOrg,
  upsertGitHubPullRequestFactFromWebhook,
} from './lib/pull-requests/github-pull-request-facts';
export {
  syncSourceControlPullRequestFacts,
  upsertSourceControlPullRequestFactFromWebhook,
} from './lib/pull-requests/source-control-pull-request-facts';
export { type PullRequestFactSnapshot } from './lib/pull-requests/pull-request-facts-store';

export * from './lib/auth';

export {
  storeOAuthStateWithId,
  consumeOAuthState,
  createMcpOauthReplay,
  consumeMcpOauthReplay,
  getMcpOauthReplay,
  updateMcpOauthReplay,
  storeTokens,
  hasValidOAuthTokens,
  storeClientInformation,
  getClientInformation,
  updateAuthStatus,
  getValidAccessToken,
} from './lib/mcp/data';

export {
  discoverOAuthEndpoints,
  discoverOAuthProtectedResourceMetadata,
  registerOAuthClient,
  getPreferredTokenEndpointAuthMethod,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  exchangeCodeForTokens,
} from './lib/mcp/oauth';

export {
  LINEAR_ORG_CONNECTION_ROLE,
  LINEAR_USER_CONNECTION_ROLE,
  findLinearDeploymentMcpConnection,
  findLinearDeploymentMcpConnectionByIdentity,
  findLinearUserMcpConnection,
  findLinearUserMcpConnectionByIdentity,
  getLinearDeploymentMetadata,
  getLinearUserMetadata,
} from './lib/mcp/linear-connections';

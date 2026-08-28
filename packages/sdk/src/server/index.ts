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

export {
  finishRun,
  maybeEnqueueBrainMemoryForCompletedRun,
} from './lib/task-runs/finish-run';
export {
  AUTOMATION_RECOMMENDATIONS_QUEUE_NAME,
  AUTOMATION_RECOMMENDATION_INITIAL_RUN_QUEUE_NAME,
  AUTOMATION_RECOMMENDATION_REPOSITORY_CAP,
  AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME,
  AUTOMATION_SIGNALS_VERSION,
  automationRecommendationJobSchema,
  automationSignalPrefetchJobSchema,
  buildAutomationRecommendationFingerprint,
  collectAutomationSignalsJob,
  enqueueAutomationRecommendations,
  enqueueAutomationRecommendationInitialRun,
  enqueueAutomationSignalPrefetch,
  processAutomationRecommendationsJob,
  runAutomationRecommendationInitialRunJob,
  type AutomationRecommendationJob,
  type AutomationRecommendationInitialRunJob,
  type AutomationSignalPrefetchJob,
} from './lib/automation-recommendations';
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
export {
  ACTIVE_PR_REVIEW_FOLLOW_UP_ATTEMPTS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_DEDUPLICATION_TTL_MS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_JOB_OPTIONS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME,
  ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_DELAY_MS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_WINDOW_MS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_SETTLEMENT_WINDOW_MS,
  activePrReviewFollowUpRequestSchema,
  enqueueActivePrReviewFollowUp,
  type ActivePrReviewFollowUpRequest,
} from './lib/task-runs/active-pr-review-follow-up';
export {
  acquireGithubPrReviewLifecycleLock,
  completeGithubPrReviewCheckFromSummary,
  GITHUB_PR_REVIEW_CHECK_NAME,
  publishGithubPrReviewCheck,
  reconcileGithubPrReviewCheckForRun,
  transferGithubPrReviewCheckToRun,
} from './lib/task-runs/github-pr-review-check';
export {
  PULL_REQUEST_MERGEABILITY_CHECK_QUEUE_NAME,
  PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS,
  PULL_REQUEST_MERGEABILITY_RETRY_DELAY_MS,
  buildPullRequestConflictMessage,
  enqueuePullRequestMergeabilityCheck,
  pullRequestMergeabilityCheckRequestSchema,
  type PullRequestMergeabilityCheckRequest,
} from './lib/task-runs/pull-request-mergeability-check';
export * from './lib/manager-slack';
export * from './lib/automation-result-metadata';
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
  notifyFastAgentParentOnArtifact,
  type FastArtifactNotificationResult,
} from './lib/artifacts/notify-fast-agent-parent';

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
  DISCORD_GATEWAY_EVENTS_QUEUE_NAME,
  enqueueDiscordGatewayEvent,
} from './lib/discord-gateway-events';

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

export {
  getCommunicationProviderAdapter,
  type RuntimeCommunicationProviderAdapter,
} from './lib/communication-providers';

export {
  findTelegramPrimaryChatId,
  TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME,
} from './lib/telegram-primary-chat';

export {
  findTeamsPrimaryConversation,
  type TeamsPrimaryConversation,
} from './lib/teams-primary-conversation';

export {
  findSlackUserDirectMessageDestination,
  findUserDirectMessageDestination,
  hasUserDirectMessageIdentity,
  sendUserDirectMessage,
  sendUserDirectMessageBestEffort,
  type UserDirectMessageDestination,
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
  PR_REVIEW_NOTIFICATION_DEBOUNCE_MS,
  PR_REVIEW_NOTIFICATION_DEFER_MS,
  PR_REVIEW_NOTIFICATION_MAX_DEFERRALS,
  PR_REVIEW_NOTIFICATION_QUEUE_NAME,
  PR_REVIEW_NOTIFICATION_ROOMOTE_FALLBACK_MS,
  buildPrReviewNotificationPostInput,
  beginCanonicalPrReviewAutoDispatch,
  beginCanonicalPrReviewPrompt,
  beginCanonicalPrReviewWebPrompt,
  beginCanonicalPrReviewWebAutoDispatch,
  completeCanonicalPrReviewAutoDispatch,
  consumePendingPrReviewActivity,
  dispatchDuePrReviewNotifications,
  enqueuePrReviewNotification,
  enqueuePrReviewNotificationInputSchema,
  formatPrReviewActivityMessage,
  finalizePrReviewNotificationRequest,
  isDurablePrReviewNotificationRequest,
  renewPrReviewNotificationRequestLease,
  hasPrReviewNotificationThreadContext,
  migrateLegacyPrReviewNotificationRequest,
  prepareCanonicalPrReviewNotificationRequest,
  prReviewActivityEventSchema,
  prReviewNotificationRequestSchema,
  requeuePendingPrReviewActivity,
  resolvePrReviewNotificationRoute,
  schedulePrReviewNotificationJob,
  startPrReviewNotificationCycle,
  startPrReviewNotificationCycleInputSchema,
  type EnqueuePrReviewNotificationInput,
  type PrReviewActivityEvent,
  type PrReviewNotificationRequest,
  type PrReviewNotificationRoute,
  type StartPrReviewNotificationCycleInput,
} from './lib/task-runs/pr-review-notification';
export {
  createPrReviewNotificationTelemetry,
  gatherPrReviewTriageContext,
  PrReviewNotificationRateLimitError,
  preparePrReviewNotificationDelivery,
  recordPrReviewNotificationDeliveryBestEffort,
  triagePrReviewActivity,
  type PreparedPrReviewNotification,
  type PrReviewTriageContext,
} from './lib/task-runs/pr-review-notification-delivery';
export * from './lib/task-runs/pr-review-action';
export * from './lib/task-runs/pr-review-follow-up-dispatch';
export * from './lib/fast-agent-surface-reply';
export * from './lib/fast-agent-provider-message';
export * from './lib/task-runs/notify-fast-agent-parent-on-pr-feedback';
export * from './lib/task-runs/notify-fast-agent-parent-on-pull-request-conflict';

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
  getPayloadRecord,
  resolveSourceControlProviderForRepositoryFromPayload,
} from './lib/pull-requests/source-control-pull-request-shared';
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
export {
  enrichPullRequestFacts,
  STORED_CHANGED_FILE_CAP,
} from './lib/pull-requests/pull-request-facts-enrichment';
export {
  readSourceControlPullRequestEnrichment,
  totalPullRequestLineChanges,
  type PullRequestEnrichment,
  type PullRequestReviewSummary,
} from './lib/pull-requests/source-control-pull-request-enrichment';

export * from './lib/auth';
export * from './lib/safe-fetch';

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

export { resolveUserMcpServerConfigs } from './routers/mcp-connections';

export {
  discoverOAuthEndpoints,
  discoverOAuthProtectedResourceMetadata,
  registerOAuthClient,
  getPreferredTokenEndpointAuthMethod,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  exchangeCodeForTokens,
  OAuthTokenRequestError,
  type OAuthRequestOptions,
} from './lib/mcp/oauth';

export {
  resolveCustomMcpAuthTarget,
  ensureCustomMcpServerMetadata,
  isDefinitiveOAuthRejection,
  type CustomMcpAuthTarget,
} from './lib/mcp/custom-auth-target';

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

export {
  requestInstancePing,
  requestLicenseUsageSync,
  resetInstancePingQueueForTests,
} from './lib/request-instance-ping';
export * from './lib/brain-clients';
export * from './lib/brain-corpus';
export * from './lib/brain-mcp';
export * from './lib/brain-github';
export * from './lib/brain-linear';
export * from './lib/brain-inference';
export * from './lib/brain-source-availability';

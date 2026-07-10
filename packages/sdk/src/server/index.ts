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

export { finishCloudJob } from './lib/cloud-jobs/finish-cloud-job';
export { findCloudJobByJobTokenClaims } from './lib/cloud-jobs/find-cloud-job';
export { createSnapshot } from './lib/cloud-jobs/enqueue-snapshot';
export { recordComputeProviderUsage } from './lib/cloud-jobs/record-compute-provider-usage';
export {
  recordTaskMessageEnvelope,
  refreshTaskTitleOnCompletion,
} from './lib/cloud-jobs/record-task-message-envelope';
export { ensureSnapshotResumeGitHubFollowUpFallback } from './lib/cloud-jobs/ensure-snapshot-resume-github-follow-up-fallback';
export * from './lib/manager-slack';
export * from './automations';
export * from './lib/manager-stats';
export {
  cleanupSandboxOidcTargetsForCloudJob,
  primeSandboxOidcTargets,
  refreshDueSandboxOidcTargets,
} from './lib/sandbox-oidc';
export {
  stampCloudJobMilestone,
  cloudJobMilestoneFields,
  type CloudJobMilestoneField,
} from './lib/cloud-jobs/stamp-milestone';

export {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
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
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_DELAY_MS,
  SLACK_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  TEAMS_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  TELEGRAM_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  enqueueSlackSuggestedTasksOnboardingFollowup,
  enqueueTeamsSuggestedTasksOnboardingFollowup,
  enqueueTelegramSuggestedTasksOnboardingFollowup,
  slackSuggestedTasksOnboardingFollowupRequestSchema,
  teamsSuggestedTasksOnboardingFollowupRequestSchema,
  telegramSuggestedTasksOnboardingFollowupRequestSchema,
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

export { createTeamsCommunicationProviderFromRuntimeCredentials } from './lib/teams-communication';

export {
  findTelegramPrimaryChatId,
  TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME,
} from './lib/telegram-primary-chat';

export {
  findTeamsPrimaryConversation,
  type TeamsPrimaryConversation,
} from './lib/teams-primary-conversation';

export {
  SLACK_PR_INACTIVITY_DELAY_MS,
  SLACK_PR_INACTIVITY_QUEUE_NAME,
  enqueueSlackPrInactivityCheck,
  enqueueSlackPrInactivityCheckInputSchema,
  fetchPullRequestSnapshotForCloudJob,
  hasPullRequestMoved,
  isPullRequestTerminal,
  pullRequestActivitySnapshotSchema,
  slackPrInactivityCheckRequestSchema,
  type EnqueueSlackPrInactivityCheckInput,
  type PullRequestActivitySnapshot,
  type SlackPrInactivityCheckRequest,
} from './lib/cloud-jobs/slack-pr-inactivity-check';

export {
  PR_REVIEW_NOTIFICATION_DEBOUNCE_MS,
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
} from './lib/cloud-jobs/pr-review-notification';
export {
  gatherPrReviewTriageContext,
  preparePrReviewNotificationDelivery,
  recordPrReviewNotificationDeliveryBestEffort,
  triagePrReviewActivity,
  type PreparedPrReviewNotification,
  type PrReviewTriageContext,
} from './lib/cloud-jobs/pr-review-notification-delivery';

export { resolveSlackJobRouting } from './lib/cloud-jobs/slack-job-routing';

export {
  findSlackConversationSubjectByUserId,
  recordSlackConversationMessage,
  recordSlackConversationMessageBestEffort,
  type SlackConversationLogInput,
} from './lib/slack-conversation-log';

export { updateTaskPrStatus } from './lib/pull-requests/update-task-pr-status';
export {
  createOrUpdateSourceControlPullRequestForCloudJob,
  findCloudJobForSourceControlMutation,
  sourceControlPullRequestMutationInputSchema,
  SourceControlMutationError,
  type SourceControlPullRequestMutationInput,
  type SourceControlPullRequestMutationResult,
} from './lib/pull-requests/source-control-pull-requests';
export {
  readSourceControlPullRequestForCloudJob,
  sourceControlPullRequestReadInputSchema,
  SourceControlReadError,
  type SourceControlPullRequestReadInput,
  type SourceControlPullRequestDetailsResult,
  type SourceControlPullRequestCommentsResult,
} from './lib/pull-requests/source-control-pull-request-reads';
export {
  writeSourceControlPullRequestForCloudJob,
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

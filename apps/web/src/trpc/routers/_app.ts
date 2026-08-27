import { z } from 'zod';
import {
  publicAuthTokenTimeoutMsSchema,
  runTokenTimeoutMsSchema,
} from '@roomote/auth';
import { FeatureFlag } from '@roomote/feature-flags';

import {
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS,
  launchCodingHarnesses,
  computeProviders,
  environmentConfigSchema,
  workspaceRoutingSettingsSchema,
  REASONING_EFFORT_VALUES,
  isTriggerableBackgroundAutomationKey,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_IDS,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCIES,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST,
  SETUP_AUTH_PROVIDER_IDS,
  isSetupModelProviderId,
  isOpenAiCompatibleProviderId,
  customMcpServerInputSchema,
  prActions,
  sourceControlProviderSchema,
  sourceControlTokenBackedProviderSchema,
  standardTaskSchema,
  taskGoalInputSchema,
  taskModelMetadataSchema,
  type ScheduleOnlyBackgroundAutomationFrequencyField,
} from '@roomote/types';

import {
  replyToFastSessionCommand,
  startFastSessionCommand,
} from '../commands/fast-sessions';
import {
  replyToFastSessionInputSchema,
  startFastSessionInputSchema,
} from '../commands/fast-sessions/input';
import {
  analyticsChartInputSchema,
  analyticsDetailsInputSchema,
  analyticsExportInputSchema,
  analyticsFilterOptionsInputSchema,
  analyticsOverviewInputSchema,
  pullRequestAnalyticsOverviewInputSchema,
  filterSchema,
  saveAsanaConnectionSchema,
  saveNotionConnectionSchema,
  saveRipplingConnectionSchema,
  saveGranolaConnectionSchema,
  saveElevenLabsConnectionSchema,
  saveGrafanaConnectionSchema,
  saveSnowflakeConnectionSchema,
  saveVercelConnectionSchema,
  saveXConnectionSchema,
  timePeriodFilterSchema,
  PERSONAL_COLOR_THEMES,
} from '@/types';

import { protectedProcedure, publicProcedure, createRouter } from '../init';

import {
  getTasksCommand,
  generateTaskSummaryCommand,
  getTaskMessageEnvelopesCommand,
  getTaskRunEventsCommand,
  getTaskByIdCommand,
  getRecentPullRequestsCommand,
  deleteTasksCommand,
  searchTasksCommand,
  updateTaskTitleCommand,
  listPinnedTaskIdsCommand,
  setTaskPinnedCommand,
} from '../commands/tasks';
import {
  getArtifactByPathCommand,
  getArtifactVersionsCommand,
  getArtifactsForTaskCommand,
} from '../commands/artifacts';
import {
  getGitHubInstallationsCommand,
  getGitHubPendingInstallationsCommand,
  getBranchesCommand,
  getCollaboratorsCommand,
  getIssuesCommand,
  getPullRequestsCommand,
  startCreateGitHubInstallationCommand,
  startCreateGitHubAppManifestCommand,
  enableGitHubAppCommand,
  finishCreateGitHubInstallationCommand,
  finishCreateGitHubAppManifestCommand,
  resolvePendingGitHubInstallationsCommand,
  startAuthenticateGitHubAccountCommand,
  finishAuthenticateGitHubAccountCommand,
  syncGitHubInstallationCommand,
  syncGitHubInstallationsCommand,
  disableGitHubAppCommand,
  getPullRequestCommand,
  executeRevertCommitCommand,
} from '../commands/github';
import {
  getPrActionCommand,
  getGitHubRoomoteMentionCommand,
  getRepositoriesCommand,
  getSourceControlConfigStatusCommand,
  clearSourceControlConfigCommand,
  saveSourceControlConfigCommand,
  setPrActionCommand,
  setGitHubRoomoteMentionCommand,
  syncRepositoriesCommand,
} from '../commands/source-control';
import {
  routeHomeTaskCommand,
  createStandardTaskRunCommand,
  cancelTaskRunCommand,
  retryFailedTaskStartCommand,
  startTaskGoalCommand,
} from '../commands/task-runs';
import {
  exchangeSlackOAuthCodeCommand,
  connectSlackAppCommand,
  createSlackAppFromManifestCommand,
  updateSlackAppManifestCommand,
  disconnectSlackAppCommand,
  getSlackInstallationCommand,
  startAuthenticateSlackAccountCommand,
  finishAuthenticateSlackAccountCommand,
  completePendingSlackAuthenticationCommand,
} from '../commands/slack';
import {
  getLinearInstallationCommand,
  disconnectLinearAppCommand,
  getLinearOauthSetupCommand,
  removeLinearOauthSetupCommand,
  saveLinearOauthSetupCommand,
} from '../commands/linear';
import { getTeamsIntegrationStatusCommand } from '../commands/teams';
import {
  getLinkedGitLabAccountCommand,
  getLinkedGiteaAccountCommand,
  getLinkedBitbucketAccountCommand,
  getLinkedAdoAccountCommand,
  getLinkedGitHubAccountCommand,
  unlinkLinkedGitHubAccountCommand,
  getLinkedLinearAccountCommand,
  unlinkLinkedLinearAccountCommand,
  getLinkedSlackAccountCommand,
  unlinkLinkedSlackAccountCommand,
  getLinkedTelegramAccountCommand,
  createTelegramLinkCodeCommand,
  unlinkLinkedTelegramAccountCommand,
  getLinkedDiscordAccountCommand,
  createDiscordLinkCodeCommand,
  unlinkLinkedDiscordAccountCommand,
  getLinkedMicrosoftTeamsAccountCommand,
} from '../commands/linked-accounts';
import {
  getPersonalAccountCapabilitiesCommand,
  getPersonalPreferencesCommand,
  acceptCookieConsentCommand,
  setPersonalPasswordCommand,
  updatePersonalPreferencesCommand,
} from '../commands/preferences';
import {
  type EnvironmentConfigVersionDetail,
  getActiveEnvironmentDefinitionTaskCommand,
  getEnvironmentsCommand,
  getWorkspaceRoutingSettingsCommand,
  updateWorkspaceRoutingSettingsCommand,
  getAvailableEnvironmentsCommand,
  getEnvironmentNamesByIdsCommand,
  getEnvironmentByIdCommand,
  getEnvironmentConfigVersionCommand,
  listEnvironmentConfigVersionsCommand,
  createEnvironmentCommand,
  updateEnvironmentCommand,
  startEnvironmentDefinitionTaskCommand,
  cancelEnvironmentDefinitionTaskCommand,
  retryEnvironmentVerificationCommand,
  deleteEnvironmentCommand,
  duplicateEnvironmentCommand,
  validateConfigCommand,
} from '../commands/environments';
import {
  getPreviewSettingsCommand,
  getTaskPreviewStatusCommand,
  startPreviewSetupTaskCommand,
  updatePreviewRuntimeConfigCommand,
} from '../commands/preview-settings';
import {
  getAuthTokenCommand,
  getSandboxAuthTokenCommand,
} from '../commands/auth';
import {
  createEnvironmentSnapshotCommand,
  clearEnvironmentSnapshotCommand,
  requestTaskRunSleepCommand,
  restoreTaskRunSnapshotCommand,
} from '../commands/snapshots';
import {
  answerSandboxUserInputRequestCommand,
  answerSandboxUserInputRequestInputSchema,
  getSandboxSessionByTaskIdCommand,
  saveDraftPromptCommand,
  sendSandboxPromptCommand,
  sendSandboxPromptInputSchema,
  takeOverBrowserControlCommand,
  updateTaskModelSelectionCommand,
  updateTaskModelSelectionInputSchema,
} from '../commands/sandbox-session';
import {
  getDeploymentMcpEnablementsCommand,
  getCuratedIntegrationsAvailabilityCommand,
  getMcpOauthReadinessCommand,
  setDeploymentMcpEnabledCommand,
  getUserMcpConnectionsCommand,
  getAsanaConnectionCommand,
  getNotionConnectionCommand,
  getRipplingConnectionCommand,
  getGranolaConnectionCommand,
  getElevenLabsConnectionCommand,
  getGrafanaConnectionCommand,
  getSnowflakeConnectionCommand,
  getVercelConnectionCommand,
  getXConnectionCommand,
  listDeploymentMcpIntegrationToolsCommand,
  saveAsanaConnectionCommand,
  saveNotionConnectionCommand,
  saveRipplingConnectionCommand,
  saveGranolaConnectionCommand,
  saveElevenLabsConnectionCommand,
  saveGrafanaConnectionCommand,
  saveSnowflakeConnectionCommand,
  saveVercelConnectionCommand,
  saveXConnectionCommand,
  setDeploymentDisabledMcpIntegrationToolsCommand,
  connectMcpCommand,
  disconnectMcpCommand,
} from '../commands/mcp-connections';

import {
  connectCustomMcpServerCommand,
  createCustomMcpServerCommand,
  deleteCustomMcpServerCommand,
  disconnectCustomMcpServerCommand,
  getCustomMcpAvailabilityCommand,
  listCustomMcpServerToolsCommand,
  listCustomMcpServersCommand,
  setCustomMcpServerDisabledToolsCommand,
  setCustomMcpServerEnabledCommand,
  updateCustomMcpServerCommand,
} from '../commands/custom-mcp-servers';

import {
  getEnvVarsCommand,
  createEnvVarCommand,
  deleteEnvVarCommand,
  updateEnvVarCommand,
} from '../commands/environment-variables';
import {
  fulfillTaskEnvVarRequestCommand,
  fulfillTaskEnvVarRequestSchema,
  markTaskEnvVarRequestFulfilledCommand,
  markTaskEnvVarRequestFulfilledSchema,
} from '../commands/task-env-var-requests';
import {
  getUsersOnlyForFilterCommand,
  getEnvironmentsForFilterCommand,
  getModelsForFilterCommand,
  getRepositoriesForFilterCommand,
  getPullRequestsForFilterCommand,
} from '../commands/filters';
import {
  batchCreateEnvironmentsCommand,
  autoCreateAgentsCommand,
  completeSetupCommand,
  getSetupStatusCommand,
} from '../commands/setup';
import { completeSetupWithStarterTasksCommand } from '../commands/setup/starter-tasks';
import { SETUP_STARTER_TASK_IDS } from '@/lib/setup-starter-tasks';
import {
  getSetupNewStatusCommand,
  getSetupBootstrapStatusCommand,
  createSetupBootstrapSlackAppFromManifestCommand,
  saveSetupBootstrapAuthConfigCommand,
  saveSetupBootstrapAuthProviderChoiceCommand,
  chooseSetupTrialInferenceCommand,
  saveSetupNewAuthConfigCommand,
  saveSetupNewAuthProviderChoiceCommand,
  saveSetupNewComputeConfigCommand,
  saveSetupNewComputeProviderChoiceCommand,
  saveSetupNewModelConfigCommand,
  saveSetupNewSourceControlConfigCommand,
  saveSetupNewSourceControlProviderChoiceCommand,
  saveSetupNewQueuedTasksCommand,
  ensureSetupNewDefaultAgentsCommand,
  listSetupRecommendationsCommand,
  startSetupRecommendationsCommand,
  setSetupRecommendationEnabledCommand,
  applySetupRecommendationsCommand,
  skipSetupRecommendationsCommand,
  runSetupRecommendationNowCommand,
  dismissSetupRecommendationsCardCommand,
  trackSetupBootstrapWelcomeSeenCommand,
  trackSetupCommsStateCommand,
  trackSetupWelcomeSeenCommand,
} from '../commands/setup-new';
import {
  getOnboardingStatusCommand,
  completeOnboardingCommand,
} from '../commands/onboarding';
import { assessBrowserOriginCommand } from '../commands/deployment';
import {
  COMMS_PROVIDER_IDS,
  getCommsStatusCommand,
  saveCommsAuthConfigCommand,
  clearCommsAuthConfigCommand,
  diagnoseDiscordPermissionsCommand,
  listDiscordChannelsCommand,
  listDiscordGuildsCommand,
  registerDiscordCommandsCommand,
  repairDiscordCommand,
  repairTelegramWebhookCommand,
  selectDiscordDestinationCommand,
} from '../commands/comms';
import {
  getComputeStatusCommand,
  saveComputeConfigCommand,
  clearComputeConfigCommand,
  setDefaultComputeProviderCommand,
  setLocalDockerEnabledCommand,
  validateDockerEnvironmentCommand,
} from '../commands/compute';
import {
  getTaskSuggestionFilterOptionsCommand,
  listTaskSuggestionsCommand,
  listTaskSuggestionHistoryCommand,
  dismissTaskSuggestionCommand,
  implementTaskSuggestionCommand,
  triggerTaskSuggestionsCommand,
} from '../commands/task-suggestions';
import {
  createCustomAutomationCommand,
  deleteCustomAutomationCommand,
  getAutomationOnboardingStatusCommand,
  getBackgroundAgentSettingsCommand,
  listAutomationDiscordChannelsCommand,
  listCustomAutomationsCommand,
  resolveCustomAutomationScheduleCommand,
  listSlackChannelsCommand,
  triggerCustomAutomationCommand,
  updateBackgroundAgentSettingsCommand,
  triggerAutomationCommand,
  updateCustomAutomationCommand,
} from '../commands/automations';
import {
  getAgentBehaviorSettingsCommand,
  updateAgentBehaviorSettingsCommand,
} from '../commands/agent-behavior';
import {
  createPasswordResetLinkCommand,
  createInviteCommand,
  getAccountLinkHelpCommand,
  getAccessPolicySettingsCommand,
  removeUserCommand,
  revokeInviteCommand,
  setLicenseKeyCommand,
  setAccountLinkHelpCommand,
  updateUserRoleCommand,
} from '../commands/access-policy';
import {
  deleteTaskModelProviderCommand,
  discoverProviderModelsCommand,
  getLaunchTaskModelsCommand,
  getTaskModelProviderSetupCommand,
  getTaskModelRoleDefaultsCommand,
  getTaskModelSettingsCommand,
  lookupTaskModelCommand,
  qualifyProviderModelCommand,
  refreshTaskModelMetadataCommand,
  saveTaskModelProviderCommand,
  suggestTaskModelsCommand,
  updateTaskModelSettingsCommand,
} from '../commands/task-models';
import { LOCAL_TASK_MODEL_PROVIDER_IDS } from '../commands/task-models/local-provider-discovery';
import {
  disconnectChatGptSubscriptionCommand,
  getChatGptSubscriptionStatusCommand,
  isChatGptSubscriptionConnectedCommand,
  pollChatGptDeviceAuthCommand,
  startChatGptDeviceAuthCommand,
  updateChatGptSubscriptionFastModeCommand,
} from '../commands/chatgpt-subscription';
import {
  disconnectGitHubCopilotSubscriptionCommand,
  getGitHubCopilotSubscriptionStatusCommand,
  isGitHubCopilotSubscriptionConnectedCommand,
  pollGitHubCopilotDeviceAuthCommand,
  startGitHubCopilotDeviceAuthCommand,
} from '../commands/github-copilot-subscription';
import {
  disconnectXaiSubscriptionCommand,
  getXaiSubscriptionStatusCommand,
  isXaiSubscriptionConnectedCommand,
  pollXaiDeviceAuthCommand,
  startXaiDeviceAuthCommand,
} from '../commands/xai-subscription';
import { getSubscriptionProviderUsageCommand } from '../commands/subscription-usage';
import { getProviderCreditBalancesCommand } from '../commands/provider-credits';
import {
  getRouterDebugSettingsCommand,
  updateRouterDebugSettingsCommand,
} from '../commands/router-debug';
import {
  listCustomSkillsCommand,
  searchCustomSkillsCommand,
  setCustomSkillAvailabilityCommand,
  saveManualSkillCommand,
  removeCustomSkillCommand,
} from '../commands/custom-skills';
import {
  getAnalyticsChartCommand,
  getAnalyticsDetailsCommand,
  exportAnalyticsCommand,
  getAnalyticsFiltersCommand,
  getAnalyticsOverviewCommand,
  getPullRequestAnalyticsOverviewCommand,
} from '../commands/analytics';
import {
  getExperimentalFlagsCommand,
  updateExperimentalFlagCommand,
} from '../commands/feature-flags';
import {
  getMiscSettingsCommand,
  setDeploymentTimeZoneCommand,
  setAnonymousAnalyticsCommand,
} from '../commands/misc-settings';
import {
  backfillBrainTaskMemoriesCommand,
  getBrainPageCommand,
  getBrainSettingsCommand,
  listBrainPagesCommand,
  retryFailedBrainTaskMemoriesCommand,
} from '../commands/brain';
import {
  getReleaseNotesCommand,
  getReleaseStatusCommand,
} from '../commands/product-releases';
import { getStatuspageIncident } from '@roomote/slack';

const standardTaskPayloadSchema = standardTaskSchema.shape.payload;
const stateRecordSchema = z.record(z.string());

function assertAdmin(auth: { isAdmin: boolean }) {
  if (!auth.isAdmin) throw new Error('Unauthorized');
}

const SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCY_SCHEMA = z.enum(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCIES,
);

const UPDATE_SETTINGS_SAVING_AUTOMATION_VALUES = [
  'callRoomoteViaEmoji',
  'channelAutoStart',
  'managerChannel',
  'managerStats',
  'providerUsageLimit',
  'reviewer',
  'conflictResolver',
  'suggester',
  'sentryTriage',
  'dependabotTriage',
  'codeqlTriage',
  ...SCHEDULE_ONLY_BACKGROUND_AUTOMATION_IDS,
  'announcer',
  'platformIssueAlerts',
] as const;

const SCHEDULE_ONLY_FREQUENCY_FIELD_SHAPE = Object.fromEntries(
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_LIST.map((automation) => [
    automation.frequencyField,
    SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCY_SCHEMA,
  ]),
) as Record<
  ScheduleOnlyBackgroundAutomationFrequencyField,
  typeof SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCY_SCHEMA
>;

function createStringEnumSchema<T extends string>(values: readonly T[]) {
  return z.custom<T>(
    (value): value is T =>
      typeof value === 'string' && values.includes(value as T),
  );
}

const conflictResolverMaxPrAgeDaysSchema = z.union([
  z.literal(CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS[0]),
  z.literal(CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS[1]),
  z.literal(CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS[2]),
  z.literal(CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS[3]),
]) as z.ZodType<(typeof CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS)[number]>;

const automationsRouter = createRouter({
  getSettings: protectedProcedure.query(({ ctx: { auth } }) =>
    getBackgroundAgentSettingsCommand(auth),
  ),

  // Slack-free subset of getSettings for the dashboard onboarding nudge.
  onboardingStatus: protectedProcedure.query(({ ctx: { auth } }) =>
    getAutomationOnboardingStatusCommand(auth),
  ),

  listRecommendations: protectedProcedure.query(({ ctx: { auth } }) =>
    listSetupRecommendationsCommand(auth),
  ),
  startRecommendations: protectedProcedure.mutation(({ ctx: { auth } }) =>
    startSetupRecommendationsCommand(auth),
  ),
  setRecommendationEnabled: protectedProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ ctx: { auth }, input }) =>
      setSetupRecommendationEnabledCommand(auth, input),
    ),
  applyRecommendations: protectedProcedure.mutation(({ ctx: { auth } }) =>
    applySetupRecommendationsCommand(auth),
  ),
  skipRecommendations: protectedProcedure.mutation(({ ctx: { auth } }) =>
    skipSetupRecommendationsCommand(auth),
  ),
  runRecommendationNow: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx: { auth }, input }) =>
      runSetupRecommendationNowCommand(auth, input),
    ),
  dismissRecommendationsCard: protectedProcedure.mutation(({ ctx: { auth } }) =>
    dismissSetupRecommendationsCardCommand(auth),
  ),

  listSlackChannels: protectedProcedure.query(({ ctx: { auth } }) =>
    listSlackChannelsCommand(auth),
  ),

  listDiscordChannels: protectedProcedure.query(({ ctx: { auth } }) =>
    listAutomationDiscordChannelsCommand(auth),
  ),

  updateSettings: protectedProcedure
    .input(
      z.object({
        savingAutomation: createStringEnumSchema(
          UPDATE_SETTINGS_SAVING_AUTOMATION_VALUES,
        ),
        reviewerEnabled: z.boolean(),
        reviewerEnvironmentScope: z.enum(['all', 'specific']),
        reviewerEnvironmentIds: z.array(z.string().uuid()),
        reviewerAuthorReviewMode: z.enum(['all', 'specific', 'none']),
        reviewerCollaborators: z.array(z.string().trim().min(1).max(255)),
        reviewerExcludedAuthors: z.string().max(8_000).nullable(),
        reviewerReviewAllPullRequestAuthors: z.boolean(),
        reviewerReviewOnCommit: z.boolean(),
        reviewerReviewDraftPrs: z.boolean(),
        reviewerPublishGithubCheck: z.boolean(),
        reviewerInstructions: z.string().max(8_000).nullable().optional(),
        reviewerRelayReviewResultsToTask: z.boolean(),
        reviewerRelayUserIds: z.array(z.string()),
        conflictResolverFrequency: z.enum([
          'off',
          'every_hour',
          'every_6_hours',
          'daily',
        ]),
        conflictResolverMaxPrAgeDays:
          conflictResolverMaxPrAgeDaysSchema.optional(),
        conflictResolverLabel: z.string().trim().min(1).max(255),
        conflictResolverInstructions: z.string().max(8_000).nullable(),
        callRoomoteViaEmojiEnabled: z.boolean().optional(),
        callRoomoteViaEmojiName: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .nullable()
          .optional(),
        callRoomoteViaEmojiInstructions: z
          .string()
          .max(8_000)
          .nullable()
          .optional(),
        channelAutoStartSlackChannels: z
          .array(
            z.object({
              channelId: z.string().trim().max(64).nullable().default(null),
              slackChannel: z.string().trim().max(160).nullable().default(null),
              instructions: z.string().max(8_000).nullable().default(null),
              launchMode: z.enum(['always_start']).default('always_start'),
              launchCriteria: z.string().max(4_000).nullable().default(null),
            }),
          )
          .default([]),
        // Genuinely optional (no default): an older client that never sends
        // this field must leave persisted Discord auto-respond rows untouched.
        channelAutoStartDiscordChannels: z
          .array(
            z.object({
              channelId: z.string().trim().max(64).nullable().default(null),
              instructions: z.string().max(8_000).nullable().default(null),
              launchMode: z.enum(['always_start']).default('always_start'),
              launchCriteria: z.string().max(4_000).nullable().default(null),
            }),
          )
          .optional(),
        managerSlackChannel: z.string().trim().min(1).max(160).nullable(),
        managerDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable()
          .optional(),
        managerStatsFrequency: z.enum(['off', 'weekly']),
        managerStatsSlackChannel: z.string().trim().min(1).max(160).nullable(),
        managerStatsDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        providerUsageLimitFrequency: z.enum(['off', 'every_hour']).optional(),
        providerUsageLimitThreshold: z
          .number()
          .int()
          .min(5)
          .max(95)
          .refine((value) => value % 5 === 0)
          .optional(),
        providerUsageLimitSlackChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable()
          .optional(),
        providerUsageLimitDiscordChannel: z.string().nullable().optional(),
        sentryTriageFrequency: z.enum(['off', 'daily', 'weekly']),
        sentryTriageSlackChannel: z.string().trim().min(1).max(160).nullable(),
        sentryTriageDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        sentryTriageProjectSlugs: z.string().max(4_000).nullable(),
        dependabotTriageFrequency: z.enum(['off', 'daily', 'weekly']),
        dependabotTriageSlackChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        dependabotTriageDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        codeqlTriageFrequency: z.enum(['off', 'daily', 'weekly']).optional(),
        codeqlTriageSlackChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable()
          .optional(),
        codeqlTriageDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable()
          .optional(),
        ...SCHEDULE_ONLY_FREQUENCY_FIELD_SHAPE,
        issueFixerInstructions: z.string().max(8_000).nullable().optional(),
        suggesterFrequency: z.enum(['off', 'daily', 'weekly']),
        suggesterSlackChannel: z.string().trim().min(1).max(160).nullable(),
        suggesterDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable()
          .optional(),
        /**
         * When true, Suggest Ideas posts to Telegram via a sticky recurring
         * forum topic in the primary chat (no thread picker).
         */
        suggesterUseTelegram: z.boolean().optional(),
        /**
         * When true, Suggest Ideas posts to the primary Microsoft Teams
         * conversation captured for this deployment.
         */
        suggesterUseTeams: z.boolean().optional(),
        suggesterInstructions: z.string().max(10_000).nullable(),
        announcerFrequency: z.enum(['off', 'daily', 'weekly']),
        announcerSlackChannel: z.string().trim().min(1).max(160).nullable(),
        announcerDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable()
          .optional(),
        announcerInstructions: z.string().max(8_000).nullable(),
        platformIssueAlertsEnabled: z.boolean().optional(),
        platformIssueSlackChannel: z.string().trim().min(1).max(160).nullable(),
        platformIssueDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable()
          .optional(),
        securityAuditorSlackChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        securityAuditorDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        codeQualityAuditorSlackChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        codeQualityAuditorDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        ciFailureTriageSlackChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
        ciFailureTriageDiscordChannel: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable(),
      }),
    )
    .mutation(({ ctx: { auth }, input }) =>
      updateBackgroundAgentSettingsCommand(auth, input),
    ),

  triggerAutomation: protectedProcedure
    .input(
      z.object({
        automationKey: z.string().refine(isTriggerableBackgroundAutomationKey, {
          message: 'Unsupported automation key.',
        }),
      }),
    )
    .mutation(({ ctx: { auth }, input }) =>
      triggerAutomationCommand(auth, input),
    ),

  listCustomAutomations: protectedProcedure.query(({ ctx: { auth } }) =>
    listCustomAutomationsCommand(auth),
  ),

  createCustomAutomation: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        prompt: z.string().trim().min(1).max(8_000),
        enabled: z.boolean(),
        scheduleMode: z.enum([
          'off',
          'every_hour',
          'every_6_hours',
          'daily',
          'weekly',
          'cron',
        ]),
        cronExpression: z.string().trim().max(200).nullable().optional(),
        model: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^/\s]+\/.+$/u, 'Model must use provider/model format.')
          .nullable()
          .optional(),
        environmentId: z.union([
          z.string().uuid(),
          z.literal(ALL_REPOSITORIES),
          z.literal(FAST_EXECUTION),
        ]),
        targetProvider: z
          .enum(['slack', 'discord', 'teams', 'telegram'])
          .optional(),
        targetMode: z.enum(['channel', 'direct_message']).optional(),
        targetChannelId: z.string().trim().min(1).max(160).optional(),
      }),
    )
    .mutation(({ ctx: { auth }, input }) =>
      createCustomAutomationCommand(auth, input),
    ),

  updateCustomAutomation: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(100),
        prompt: z.string().trim().min(1).max(8_000),
        enabled: z.boolean(),
        scheduleMode: z.enum([
          'off',
          'every_hour',
          'every_6_hours',
          'daily',
          'weekly',
          'cron',
        ]),
        cronExpression: z.string().trim().max(200).nullable().optional(),
        model: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^/\s]+\/.+$/u, 'Model must use provider/model format.')
          .nullable()
          .optional(),
        environmentId: z.union([
          z.string().uuid(),
          z.literal(ALL_REPOSITORIES),
          z.literal(FAST_EXECUTION),
        ]),
        targetProvider: z
          .enum(['slack', 'discord', 'teams', 'telegram'])
          .optional(),
        targetMode: z.enum(['channel', 'direct_message']).optional(),
        targetChannelId: z.string().trim().min(1).max(160).optional(),
      }),
    )
    .mutation(({ ctx: { auth }, input }) =>
      updateCustomAutomationCommand(auth, input),
    ),

  deleteCustomAutomation: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx: { auth }, input }) =>
      deleteCustomAutomationCommand(auth, input),
    ),

  triggerCustomAutomation: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx: { auth }, input }) =>
      triggerCustomAutomationCommand(auth, input),
    ),
  resolveCustomAutomationSchedule: protectedProcedure
    .input(z.object({ schedule: z.string().trim().min(1).max(500) }))
    .mutation(({ ctx: { auth }, input }) =>
      resolveCustomAutomationScheduleCommand(auth, input),
    ),
});

export const appRouter = createRouter({
  statuspage: createRouter({
    incident: publicProcedure.query(() => getStatuspageIncident()),
  }),
  analytics: createRouter({
    overview: protectedProcedure
      .input(analyticsOverviewInputSchema)
      .query(({ ctx: { auth }, input }) => {
        assertAdmin(auth);
        return getAnalyticsOverviewCommand(auth, input);
      }),

    pullRequestOverview: protectedProcedure
      .input(pullRequestAnalyticsOverviewInputSchema)
      .query(({ ctx: { auth }, input }) => {
        assertAdmin(auth);
        return getPullRequestAnalyticsOverviewCommand(auth, input);
      }),

    chart: protectedProcedure
      .input(analyticsChartInputSchema)
      .query(({ ctx: { auth }, input }) => {
        assertAdmin(auth);
        return getAnalyticsChartCommand(auth, input);
      }),

    filters: protectedProcedure
      .input(analyticsFilterOptionsInputSchema)
      .query(({ ctx: { auth }, input }) => {
        assertAdmin(auth);
        return getAnalyticsFiltersCommand(auth, input);
      }),

    details: protectedProcedure
      .input(analyticsDetailsInputSchema)
      .query(({ ctx: { auth }, input }) => {
        assertAdmin(auth);
        return getAnalyticsDetailsCommand(auth, input);
      }),

    export: protectedProcedure
      .input(analyticsExportInputSchema)
      .query(({ ctx: { auth }, input }) => {
        assertAdmin(auth);
        return exportAnalyticsCommand(auth, input);
      }),
  }),

  tasks: createRouter({
    list: protectedProcedure
      .input(
        z.object({
          limit: z.number().optional(),
          cursor: z.union([z.string(), z.number()]).optional(),
          filters: z.array(filterSchema).optional(),
          timePeriod: timePeriodFilterSchema.optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) => getTasksCommand(auth, input)),

    byId: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          includeArtifacts: z.boolean().optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) => getTaskByIdCommand(auth, input)),

    messageEnvelopes: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .query(({ input }) => getTaskMessageEnvelopesCommand(input)),

    runEvents: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .query(({ input }) => getTaskRunEventsCommand(input)),

    generateSummary: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .query(({ ctx: { auth }, input }) =>
        generateTaskSummaryCommand(auth, input),
      ),

    recentPullRequests: protectedProcedure.query(({ ctx: { auth } }) =>
      getRecentPullRequestsCommand(auth),
    ),

    delete: protectedProcedure
      .input(z.object({ taskIds: z.array(z.string()).min(1) }))
      .mutation(({ ctx: { auth }, input }) => deleteTasksCommand(auth, input)),

    updateTitle: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          title: z.string().trim().min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updateTaskTitleCommand(auth, input),
      ),

    search: protectedProcedure
      .input(
        z.object({
          query: z.string().optional(),
          limit: z.number().min(1).max(50).optional(),
          includeIds: z.array(z.string()).max(20).optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) => searchTasksCommand(auth, input)),

    pins: protectedProcedure.query(({ ctx: { auth } }) =>
      listPinnedTaskIdsCommand(auth),
    ),

    setPinned: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          pinned: z.boolean(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        setTaskPinnedCommand(auth, input),
      ),
  }),

  artifacts: createRouter({
    byPath: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          path: z.string(),
          version: z.number().optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        getArtifactByPathCommand(auth, input),
      ),

    versions: protectedProcedure
      .input(z.object({ taskId: z.string(), path: z.string() }))
      .query(({ ctx: { auth }, input }) =>
        getArtifactVersionsCommand(auth, input),
      ),

    forTask: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .query(({ ctx: { auth }, input }) =>
        getArtifactsForTaskCommand(auth, input),
      ),
  }),

  taskRuns: createRouter({
    startGoal: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          goal: taskGoalInputSchema,
          clientMessageId: z.string().optional(),
          userImageUrl: z.string().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        startTaskGoalCommand(auth, input),
      ),

    routeHomeTask: protectedProcedure
      .input(
        z.object({
          description: z.string(),
          images: z.array(z.string()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        routeHomeTaskCommand(auth, input),
      ),

    createStandardTask: protectedProcedure
      .input(
        z.object({
          harness: z.enum(launchCodingHarnesses).optional(),
          model: z.string().trim().min(1).optional(),
          computeProvider: z.enum(computeProviders).optional(),
          sourceTaskId: z.string().optional(),
          sourceArtifactId: z.string().uuid().optional(),
          sourceArtifactPath: z.string().optional(),
          sourceArtifactVersion: z.number().int().optional(),
          payload: standardTaskPayloadSchema,
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        createStandardTaskRunCommand(auth, input),
      ),

    cancel: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          runId: z.number().int().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        cancelTaskRunCommand(auth, input),
      ),

    retryFailedStart: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          runId: z.number().int().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        retryFailedTaskStartCommand(auth, input),
      ),
  }),

  github: createRouter({
    installations: protectedProcedure.query(({ ctx: { auth } }) =>
      getGitHubInstallationsCommand(auth),
    ),

    pendingInstallations: protectedProcedure.query(({ ctx: { auth } }) =>
      getGitHubPendingInstallationsCommand(auth),
    ),

    resolvePendingInstallations: protectedProcedure.mutation(
      ({ ctx: { auth } }) => resolvePendingGitHubInstallationsCommand(auth),
    ),

    branches: protectedProcedure
      .input(z.object({ fullName: z.string() }))
      .query(({ ctx: { auth }, input }) => getBranchesCommand(auth, input)),

    collaborators: protectedProcedure.query(({ ctx: { auth } }) =>
      getCollaboratorsCommand(auth),
    ),

    issues: protectedProcedure.query(({ ctx: { auth } }) =>
      getIssuesCommand(auth),
    ),

    pullRequests: protectedProcedure.query(({ ctx: { auth } }) =>
      getPullRequestsCommand(auth),
    ),

    startCreateInstallation: protectedProcedure
      .input(z.object({ state: stateRecordSchema.optional() }).optional())
      .mutation(({ ctx: { auth }, input }) =>
        startCreateGitHubInstallationCommand(auth, input?.state),
      ),

    startCreateAppManifest: protectedProcedure
      .input(
        z
          .object({
            state: stateRecordSchema.optional(),
            organization: z.string().optional(),
          })
          .optional(),
      )
      .mutation(({ ctx: { auth }, input }) =>
        startCreateGitHubAppManifestCommand(
          auth,
          input?.state,
          input?.organization,
        ),
      ),

    enableApp: protectedProcedure
      .input(z.object({ state: stateRecordSchema.optional() }).optional())
      .mutation(({ ctx: { auth }, input }) =>
        enableGitHubAppCommand(auth, input?.state),
      ),

    finishCreateInstallation: protectedProcedure
      .input(z.object({ code: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        finishCreateGitHubInstallationCommand(auth, input),
      ),

    finishCreateAppManifest: protectedProcedure
      .input(
        z.object({
          code: z.string().min(1),
          redirect: z.string().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        finishCreateGitHubAppManifestCommand(auth, input),
      ),

    startAuthenticateAccount: protectedProcedure
      .input(z.object({ state: stateRecordSchema.optional() }).optional())
      .mutation(({ ctx: { auth }, input }) =>
        startAuthenticateGitHubAccountCommand(auth, input?.state),
      ),

    finishAuthenticateAccount: protectedProcedure
      .input(z.object({ code: z.string().min(1), state: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        finishAuthenticateGitHubAccountCommand(auth, input),
      ),

    syncInstallation: protectedProcedure
      .input(z.object({ installationId: z.number().int().positive() }))
      .mutation(({ ctx: { auth }, input }) =>
        syncGitHubInstallationCommand(auth, input),
      ),

    syncInstallations: protectedProcedure.mutation(({ ctx: { auth } }) =>
      syncGitHubInstallationsCommand(auth),
    ),

    disableApp: protectedProcedure.mutation(({ ctx: { auth } }) =>
      disableGitHubAppCommand(auth),
    ),

    pullRequest: protectedProcedure
      .input(
        z.object({
          owner: z.string().min(1),
          repo: z.string().min(1),
          prNumber: z.number().int().positive(),
        }),
      )
      .query(({ ctx: { auth }, input }) => getPullRequestCommand(auth, input)),

    executeRevertCommit: protectedProcedure
      .input(
        z.object({
          repo: z.string().min(1),
          prNumber: z.number().int().positive(),
          commitSha: z.string().min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        executeRevertCommitCommand(auth, input),
      ),
  }),

  sourceControl: createRouter({
    repositories: protectedProcedure
      .input(
        z
          .object({
            includeEmptyState: z.boolean().optional(),
            sourceControlProvider: sourceControlProviderSchema.optional(),
          })
          .optional(),
      )
      .query(({ ctx: { auth }, input }) => getRepositoriesCommand(auth, input)),

    configStatus: protectedProcedure.query(({ ctx: { auth } }) =>
      getSourceControlConfigStatusCommand(auth),
    ),

    prAction: protectedProcedure.query(({ ctx: { auth } }) =>
      getPrActionCommand(auth),
    ),

    setPrAction: protectedProcedure
      .input(z.object({ prAction: z.enum(prActions) }))
      .mutation(({ ctx: { auth }, input }) => setPrActionCommand(auth, input)),

    githubRoomoteMention: protectedProcedure.query(({ ctx: { auth } }) =>
      getGitHubRoomoteMentionCommand(auth),
    ),

    setGitHubRoomoteMention: protectedProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(({ ctx: { auth }, input }) =>
        setGitHubRoomoteMentionCommand(auth, input),
      ),

    syncRepositories: protectedProcedure
      .input(
        z.object({
          provider: sourceControlTokenBackedProviderSchema,
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        syncRepositoriesCommand(auth, input),
      ),

    saveConfig: protectedProcedure
      .input(
        z.object({
          provider: sourceControlProviderSchema,
          values: z.record(z.string().trim()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSourceControlConfigCommand(auth, input),
      ),

    clearConfig: protectedProcedure
      .input(z.object({ provider: sourceControlProviderSchema }))
      .mutation(({ ctx: { auth }, input }) =>
        clearSourceControlConfigCommand(auth, input),
      ),
  }),

  slack: createRouter({
    installation: protectedProcedure.query(({ ctx: { auth } }) =>
      getSlackInstallationCommand(auth),
    ),

    connectApp: protectedProcedure
      .input(z.object({ redirectPath: z.string().optional() }).optional())
      .mutation(({ ctx: { auth }, input }) =>
        connectSlackAppCommand(auth, input),
      ),

    createAppFromManifest: protectedProcedure
      .input(z.object({ configToken: z.string().trim().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        createSlackAppFromManifestCommand(auth, input),
      ),

    updateAppManifest: protectedProcedure
      .input(z.object({ configToken: z.string().trim().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        updateSlackAppManifestCommand(auth, input),
      ),

    disconnectApp: protectedProcedure.mutation(({ ctx: { auth } }) =>
      disconnectSlackAppCommand(auth),
    ),

    startAuthenticateAccount: protectedProcedure
      .input(z.object({ state: stateRecordSchema.optional() }).optional())
      .mutation(({ ctx: { auth }, input }) =>
        startAuthenticateSlackAccountCommand(auth, input?.state),
      ),

    finishAuthenticateAccount: protectedProcedure
      .input(z.object({ code: z.string().min(1), state: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        finishAuthenticateSlackAccountCommand(auth, input),
      ),

    exchangeOAuthCode: protectedProcedure
      .input(z.object({ code: z.string().min(1), state: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        exchangeSlackOAuthCodeCommand(auth, input),
      ),

    completePendingAuth: protectedProcedure
      .input(z.object({ stateToken: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        completePendingSlackAuthenticationCommand(auth, input),
      ),
  }),

  linear: createRouter({
    installation: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinearInstallationCommand(auth),
    ),

    disconnectApp: protectedProcedure.mutation(({ ctx: { auth } }) =>
      disconnectLinearAppCommand(auth),
    ),

    oauthSetup: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinearOauthSetupCommand(auth),
    ),

    removeOauthSetup: protectedProcedure.mutation(({ ctx: { auth } }) =>
      removeLinearOauthSetupCommand(auth),
    ),

    saveOauthSetup: protectedProcedure
      .input(
        z.object({
          clientId: z.string().max(1_000),
          clientSecret: z.string().max(10_000),
          webhookSecret: z.string().max(10_000),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveLinearOauthSetupCommand(auth, input),
      ),
  }),

  teams: createRouter({
    integrationStatus: protectedProcedure.query(({ ctx: { auth } }) =>
      getTeamsIntegrationStatusCommand(auth),
    ),
  }),

  linkedAccounts: createRouter({
    github: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedGitHubAccountCommand(auth),
    ),

    gitlab: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedGitLabAccountCommand(auth),
    ),

    gitea: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedGiteaAccountCommand(auth),
    ),

    bitbucket: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedBitbucketAccountCommand(auth),
    ),

    ado: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedAdoAccountCommand(auth),
    ),

    unlinkGitHub: protectedProcedure.mutation(({ ctx: { auth } }) =>
      unlinkLinkedGitHubAccountCommand(auth),
    ),

    linear: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedLinearAccountCommand(auth),
    ),

    unlinkLinear: protectedProcedure.mutation(({ ctx: { auth } }) =>
      unlinkLinkedLinearAccountCommand(auth),
    ),

    slack: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedSlackAccountCommand(auth),
    ),

    unlinkSlack: protectedProcedure.mutation(({ ctx: { auth } }) =>
      unlinkLinkedSlackAccountCommand(auth),
    ),

    microsoftTeams: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedMicrosoftTeamsAccountCommand(auth),
    ),

    telegram: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedTelegramAccountCommand(auth),
    ),

    createTelegramLinkCode: protectedProcedure.mutation(({ ctx: { auth } }) =>
      createTelegramLinkCodeCommand(auth),
    ),

    unlinkTelegram: protectedProcedure.mutation(({ ctx: { auth } }) =>
      unlinkLinkedTelegramAccountCommand(auth),
    ),

    discord: protectedProcedure.query(({ ctx: { auth } }) =>
      getLinkedDiscordAccountCommand(auth),
    ),

    createDiscordLinkCode: protectedProcedure.mutation(({ ctx: { auth } }) =>
      createDiscordLinkCodeCommand(auth),
    ),

    unlinkDiscord: protectedProcedure.mutation(({ ctx: { auth } }) =>
      unlinkLinkedDiscordAccountCommand(auth),
    ),
  }),

  preferences: createRouter({
    acceptCookieConsent: protectedProcedure.mutation(({ ctx: { auth } }) =>
      acceptCookieConsentCommand(auth),
    ),
    accountCapabilities: protectedProcedure.query(({ ctx: { auth } }) =>
      getPersonalAccountCapabilitiesCommand(auth),
    ),
    setPassword: protectedProcedure
      .input(z.object({ newPassword: z.string().min(8) }))
      .mutation(({ ctx: { auth }, input }) =>
        setPersonalPasswordCommand(auth, input.newPassword),
      ),
    getPersonal: protectedProcedure.query(({ ctx: { auth } }) =>
      getPersonalPreferencesCommand(auth),
    ),
    updatePersonal: protectedProcedure
      .input(
        z
          .object({
            colorTheme: z.enum(PERSONAL_COLOR_THEMES).optional(),
            mindReaderMode: z.boolean().optional(),
            narrationMode: z.boolean().optional(),
            communicationsFastModeDefault: z.boolean().optional(),
          })
          .refine(
            (input) =>
              input.colorTheme !== undefined ||
              input.mindReaderMode !== undefined ||
              input.narrationMode !== undefined ||
              input.communicationsFastModeDefault !== undefined,
            {
              message: 'Expected at least one personal preference to update.',
            },
          ),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updatePersonalPreferencesCommand(auth, input),
      ),
  }),

  environments: createRouter({
    list: protectedProcedure.query(({ ctx: { auth } }) =>
      getEnvironmentsCommand(auth),
    ),

    routingSettings: protectedProcedure.query(({ ctx: { auth } }) =>
      getWorkspaceRoutingSettingsCommand(auth),
    ),

    updateRoutingSettings: protectedProcedure
      .input(workspaceRoutingSettingsSchema)
      .mutation(({ ctx: { auth }, input }) =>
        updateWorkspaceRoutingSettingsCommand(auth, input),
      ),

    available: protectedProcedure
      .input(z.object({ repository: z.string().optional() }).optional())
      .query(({ ctx: { auth }, input }) =>
        getAvailableEnvironmentsCommand(auth, input),
      ),

    namesByIds: protectedProcedure
      .input(z.object({ ids: z.array(z.string()).max(20) }))
      .query(({ ctx: { auth }, input }) =>
        getEnvironmentNamesByIdsCommand(auth, input),
      ),

    byId: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(({ ctx: { auth }, input }) =>
        getEnvironmentByIdCommand(auth, input),
      ),

    listConfigVersions: protectedProcedure
      .input(z.object({ environmentId: z.string().uuid() }))
      .query(({ ctx: { auth }, input }) =>
        listEnvironmentConfigVersionsCommand(auth, input),
      ),

    getConfigVersion: protectedProcedure
      .input(
        z.object({
          environmentId: z.string().uuid(),
          version: z.number().int().min(1),
        }),
      )
      .query(
        ({
          ctx: { auth },
          input,
        }): Promise<EnvironmentConfigVersionDetail | null> =>
          getEnvironmentConfigVersionCommand(auth, input),
      ),

    activeDefinitionTask: protectedProcedure
      .input(
        z.object({
          environmentId: z.string().uuid(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        getActiveEnvironmentDefinitionTaskCommand(auth, input),
      ),

    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          config: z.record(z.unknown()),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        createEnvironmentCommand(
          auth,
          input as Parameters<typeof createEnvironmentCommand>[1],
        ),
      ),

    update: protectedProcedure
      .input(
        z.object({
          id: z.string(),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          agentInstructions: z.string().optional(),
          config: z.record(z.unknown()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updateEnvironmentCommand(
          auth,
          input as Parameters<typeof updateEnvironmentCommand>[1],
        ),
      ),

    startDefinitionTask: protectedProcedure
      .input(
        z.object({
          repositoryIds: z.array(z.string().uuid()).min(1),
          environmentId: z.string().optional(),
          changeRequest: z.string().trim().min(1).max(8_000).optional(),
          selectedModelId: z.string().trim().min(1).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        startEnvironmentDefinitionTaskCommand(auth, input),
      ),

    cancelDefinitionTask: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .mutation(({ ctx: { auth }, input }) =>
        cancelEnvironmentDefinitionTaskCommand(auth, input),
      ),

    retryVerification: protectedProcedure
      .input(z.object({ environmentId: z.string().uuid() }))
      .mutation(({ ctx: { auth }, input }) =>
        retryEnvironmentVerificationCommand(auth, input),
      ),

    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx: { auth }, input }) =>
        deleteEnvironmentCommand(auth, input),
      ),

    duplicate: protectedProcedure
      .input(z.object({ id: z.string(), newName: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        duplicateEnvironmentCommand(auth, input),
      ),

    validateConfig: protectedProcedure
      .input(z.object({ config: environmentConfigSchema }))
      .mutation(({ ctx: { auth }, input }) =>
        validateConfigCommand(auth, input),
      ),
  }),

  previewSettings: createRouter({
    get: protectedProcedure.query(({ ctx: { auth } }) =>
      getPreviewSettingsCommand(auth),
    ),

    updateRuntimeConfig: protectedProcedure
      .input(
        z.object({
          previewProxyBaseUrl: z.string(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updatePreviewRuntimeConfigCommand(auth, input),
      ),

    taskStatus: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .query(({ ctx: { auth }, input }) =>
        getTaskPreviewStatusCommand(auth, input),
      ),

    startSetupTask: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          mode: z.enum(['configure', 'repair']).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        startPreviewSetupTaskCommand(auth, input),
      ),
  }),
  snapshots: createRouter({
    createEnvironment: protectedProcedure
      .input(
        z.object({
          environmentId: z.string(),
          provider: z.enum(computeProviders).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        createEnvironmentSnapshotCommand(auth, input),
      ),

    clearEnvironment: protectedProcedure
      .input(
        z.object({
          environmentId: z.string(),
          provider: z.enum(computeProviders).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        clearEnvironmentSnapshotCommand(auth, input),
      ),

    requestTaskRunSleep: protectedProcedure
      .input(z.object({ runId: z.number() }))
      .mutation(({ ctx: { auth }, input }) =>
        requestTaskRunSleepCommand(auth, input),
      ),

    restoreTaskRun: protectedProcedure
      .input(
        z.object({
          sourceSnapshotId: z.string(),
          sourceRunId: z.number(),
          description: z.string().optional(),
          clientMessageId: z.string().optional(),
          resumePrompt: z.string().max(50_000).optional(),
          resumePromptImages: z.array(z.string()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        restoreTaskRunSnapshotCommand(auth, input),
      ),
  }),

  customMcpServers: createRouter({
    availability: protectedProcedure.query(() =>
      getCustomMcpAvailabilityCommand(),
    ),

    list: protectedProcedure.query(({ ctx: { auth } }) =>
      listCustomMcpServersCommand(auth),
    ),

    create: protectedProcedure
      .input(customMcpServerInputSchema)
      .mutation(({ ctx: { auth }, input }) =>
        createCustomMcpServerCommand(auth, input),
      ),

    update: protectedProcedure
      .input(
        z.object({ id: z.string().uuid(), server: customMcpServerInputSchema }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updateCustomMcpServerCommand(auth, input),
      ),

    delete: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(({ ctx: { auth }, input }) =>
        deleteCustomMcpServerCommand(auth, input),
      ),

    setEnabled: protectedProcedure
      .input(z.object({ id: z.string().uuid(), enabled: z.boolean() }))
      .mutation(({ ctx: { auth }, input }) =>
        setCustomMcpServerEnabledCommand(auth, input),
      ),

    setDisabledTools: protectedProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          disabledTools: z.array(z.string().min(1)),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        setCustomMcpServerDisabledToolsCommand(auth, input),
      ),

    listTools: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(({ ctx: { auth }, input }) =>
        listCustomMcpServerToolsCommand(auth, input),
      ),

    connect: protectedProcedure
      .input(
        z.object({ id: z.string().uuid(), redirectTo: z.string().optional() }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        connectCustomMcpServerCommand(auth, input),
      ),

    disconnect: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(({ ctx: { auth }, input }) =>
        disconnectCustomMcpServerCommand(auth, input),
      ),
  }),

  mcpConnections: createRouter({
    availability: protectedProcedure.query(() =>
      getCuratedIntegrationsAvailabilityCommand(),
    ),

    deploymentEnablements: protectedProcedure.query(({ ctx: { auth } }) =>
      getDeploymentMcpEnablementsCommand(auth),
    ),

    oauthReadiness: protectedProcedure.query(({ ctx: { auth } }) =>
      getMcpOauthReadinessCommand(auth),
    ),

    setDeploymentEnabled: protectedProcedure
      .input(z.object({ mcpId: z.string(), enabled: z.boolean() }))
      .mutation(({ ctx: { auth }, input }) =>
        setDeploymentMcpEnabledCommand(auth, input),
      ),

    userConnections: protectedProcedure.query(({ ctx: { auth } }) =>
      getUserMcpConnectionsCommand(auth),
    ),

    snowflakeConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getSnowflakeConnectionCommand(auth),
    ),

    asanaConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getAsanaConnectionCommand(auth),
    ),

    notionConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getNotionConnectionCommand(auth),
    ),

    ripplingConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getRipplingConnectionCommand(auth),
    ),

    granolaConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getGranolaConnectionCommand(auth),
    ),

    elevenLabsConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getElevenLabsConnectionCommand(auth),
    ),

    grafanaConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getGrafanaConnectionCommand(auth),
    ),

    vercelConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getVercelConnectionCommand(auth),
    ),

    xConnection: protectedProcedure.query(({ ctx: { auth } }) =>
      getXConnectionCommand(auth),
    ),

    listTools: protectedProcedure
      .input(z.object({ mcpId: z.string() }))
      .query(({ ctx: { auth }, input }) =>
        listDeploymentMcpIntegrationToolsCommand(auth, input),
      ),

    setDisabledTools: protectedProcedure
      .input(
        z.object({
          mcpId: z.string(),
          disabledTools: z.array(z.string().min(1)),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        setDeploymentDisabledMcpIntegrationToolsCommand(auth, input),
      ),

    connect: protectedProcedure
      .input(
        z.object({
          mcpId: z.string(),
          redirectTo: z.string().optional(),
          role: z
            .enum(['default', 'linear_org_install', 'linear_user_link'])
            .optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) => connectMcpCommand(auth, input)),

    disconnect: protectedProcedure
      .input(
        z.object({
          mcpId: z.string(),
          role: z
            .enum(['default', 'linear_org_install', 'linear_user_link'])
            .optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        disconnectMcpCommand(auth, input),
      ),

    saveSnowflakeConnection: protectedProcedure
      .input(saveSnowflakeConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveSnowflakeConnectionCommand(auth, input),
      ),

    saveAsanaConnection: protectedProcedure
      .input(saveAsanaConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveAsanaConnectionCommand(auth, input),
      ),

    saveNotionConnection: protectedProcedure
      .input(saveNotionConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveNotionConnectionCommand(auth, input),
      ),

    saveRipplingConnection: protectedProcedure
      .input(saveRipplingConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveRipplingConnectionCommand(auth, input),
      ),

    saveGranolaConnection: protectedProcedure
      .input(saveGranolaConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveGranolaConnectionCommand(auth, input),
      ),

    saveElevenLabsConnection: protectedProcedure
      .input(saveElevenLabsConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveElevenLabsConnectionCommand(auth, input),
      ),

    saveGrafanaConnection: protectedProcedure
      .input(saveGrafanaConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveGrafanaConnectionCommand(auth, input),
      ),

    saveVercelConnection: protectedProcedure
      .input(saveVercelConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveVercelConnectionCommand(auth, input),
      ),

    saveXConnection: protectedProcedure
      .input(saveXConnectionSchema)
      .mutation(({ ctx: { auth }, input }) =>
        saveXConnectionCommand(auth, input),
      ),
  }),

  auth: createRouter({
    token: protectedProcedure
      .input(z.object({ timeoutMs: publicAuthTokenTimeoutMsSchema.optional() }))
      .query(({ ctx: { auth }, input }) => getAuthTokenCommand(auth, input)),
    sandboxToken: protectedProcedure
      .input(
        z.object({
          runId: z.number(),
          timeoutMs: runTokenTimeoutMsSchema.optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        getSandboxAuthTokenCommand(auth, input),
      ),
  }),

  environmentVariables: createRouter({
    list: protectedProcedure.query(({ ctx: { auth } }) =>
      getEnvVarsCommand(auth),
    ),

    create: protectedProcedure
      .input(
        z.object({
          name: z
            .string()
            .min(1)
            .max(255)
            .regex(/^[A-Z][A-Z0-9_]*$/),
          value: z.string().min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) => createEnvVarCommand(auth, input)),

    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx: { auth }, input }) => deleteEnvVarCommand(auth, input)),

    update: protectedProcedure
      .input(z.object({ id: z.string(), value: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) => updateEnvVarCommand(auth, input)),
  }),

  comms: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getCommsStatusCommand(auth),
    ),

    saveAuthConfig: protectedProcedure
      .input(
        z.object({
          provider: z.enum(COMMS_PROVIDER_IDS),
          values: z.record(z.string().trim()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveCommsAuthConfigCommand(auth, input),
      ),

    clearAuthConfig: protectedProcedure
      .input(z.object({ provider: z.enum(COMMS_PROVIDER_IDS) }))
      .mutation(({ ctx: { auth }, input }) =>
        clearCommsAuthConfigCommand(auth, input),
      ),

    repairTelegram: protectedProcedure.mutation(({ ctx: { auth } }) =>
      repairTelegramWebhookCommand(auth),
    ),

    listDiscordGuilds: protectedProcedure.query(({ ctx: { auth } }) =>
      listDiscordGuildsCommand(auth),
    ),

    listDiscordChannels: protectedProcedure
      .input(z.object({ guildId: z.string().trim().min(1).max(32) }))
      .query(({ ctx: { auth }, input }) =>
        listDiscordChannelsCommand(auth, input),
      ),

    selectDiscordDestination: protectedProcedure
      .input(
        z.object({
          guildId: z.string().trim().min(1).max(32),
          channelId: z.string().trim().min(1).max(32),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        selectDiscordDestinationCommand(auth, input),
      ),

    diagnoseDiscordPermissions: protectedProcedure
      .input(
        z.object({
          guildId: z.string().trim().min(1).max(32),
          channelId: z.string().trim().min(1).max(32),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        diagnoseDiscordPermissionsCommand(auth, input),
      ),

    registerDiscordCommands: protectedProcedure.mutation(({ ctx: { auth } }) =>
      registerDiscordCommandsCommand(auth),
    ),

    repairDiscord: protectedProcedure.mutation(({ ctx: { auth } }) =>
      repairDiscordCommand(auth),
    ),
  }),

  compute: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getComputeStatusCommand(auth),
    ),

    saveConfig: protectedProcedure
      .input(
        z.object({
          provider: z.enum(computeProviders),
          values: z.record(z.string().trim()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveComputeConfigCommand(auth, input),
      ),

    clearConfig: protectedProcedure
      .input(z.object({ provider: z.enum(computeProviders) }))
      .mutation(({ ctx: { auth }, input }) =>
        clearComputeConfigCommand(auth, input),
      ),

    setDefaultProvider: protectedProcedure
      .input(z.object({ provider: z.enum(computeProviders) }))
      .mutation(({ ctx: { auth }, input }) =>
        setDefaultComputeProviderCommand(auth, input),
      ),

    setLocalDockerEnabled: protectedProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(({ ctx: { auth }, input }) =>
        setLocalDockerEnabledCommand(auth, input),
      ),

    validateDockerEnvironment: protectedProcedure.mutation(
      ({ ctx: { auth } }) => validateDockerEnvironmentCommand(auth),
    ),
  }),

  taskEnvVarRequests: createRouter({
    fulfill: protectedProcedure
      .input(fulfillTaskEnvVarRequestSchema)
      .mutation(({ ctx: { auth }, input }) =>
        fulfillTaskEnvVarRequestCommand(auth, input),
      ),

    markFulfilled: protectedProcedure
      .input(markTaskEnvVarRequestFulfilledSchema)
      .mutation(({ ctx: { auth }, input }) =>
        markTaskEnvVarRequestFulfilledCommand(auth, input),
      ),
  }),

  sandboxSession: createRouter({
    byTaskId: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .query(({ ctx: { auth }, input }) =>
        getSandboxSessionByTaskIdCommand(auth, input),
      ),

    saveDraftPrompt: protectedProcedure
      .input(
        z.object({
          runId: z.number(),
          draftPrompt: z.string().max(50_000),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveDraftPromptCommand(auth, input),
      ),

    sendPrompt: protectedProcedure
      .input(sendSandboxPromptInputSchema)
      .mutation(({ ctx: { auth }, input }) =>
        sendSandboxPromptCommand(auth, input),
      ),

    answerUserInputRequest: protectedProcedure
      .input(answerSandboxUserInputRequestInputSchema)
      .mutation(({ ctx: { auth }, input }) =>
        answerSandboxUserInputRequestCommand(auth, input),
      ),

    takeOverBrowserControl: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        takeOverBrowserControlCommand(auth, input),
      ),

    updateTaskModelSelection: protectedProcedure
      .input(updateTaskModelSelectionInputSchema)
      .mutation(({ ctx: { auth }, input }) =>
        updateTaskModelSelectionCommand(auth, input),
      ),
  }),

  filters: createRouter({
    users: protectedProcedure
      .input(
        z.object({
          repositoryName: z.string().nullish(),
          category: z.string().nullish(),
          timePeriod: timePeriodFilterSchema.optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        getUsersOnlyForFilterCommand(auth, input),
      ),

    environments: protectedProcedure.query(({ ctx: { auth } }) =>
      getEnvironmentsForFilterCommand(auth),
    ),

    repositories: protectedProcedure
      .input(
        z.object({
          userId: z.string().nullish(),
          category: z.string().nullish(),
          timePeriod: timePeriodFilterSchema.optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        getRepositoriesForFilterCommand(auth, input),
      ),

    models: protectedProcedure
      .input(
        z.object({
          userId: z.string().nullish(),
          category: z.string().nullish(),
          repositoryName: z.string().nullish(),
          timePeriod: timePeriodFilterSchema.optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        getModelsForFilterCommand(auth, input),
      ),

    pullRequests: protectedProcedure
      .input(
        z.object({
          userId: z.string().nullish(),
          category: z.string().nullish(),
          repositoryName: z.string().nullish(),
          timePeriod: timePeriodFilterSchema.optional(),
          search: z.string().optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        getPullRequestsForFilterCommand(auth, input),
      ),
  }),

  taskModels: createRouter({
    launchOptions: protectedProcedure.query(({ ctx: { auth } }) =>
      getLaunchTaskModelsCommand(auth),
    ),

    roleDefaults: protectedProcedure.query(({ ctx: { auth } }) =>
      getTaskModelRoleDefaultsCommand(auth),
    ),

    get: protectedProcedure.query(({ ctx: { auth } }) =>
      getTaskModelSettingsCommand(auth),
    ),

    providerSetup: protectedProcedure.query(({ ctx: { auth } }) =>
      getTaskModelProviderSetupCommand(auth),
    ),

    saveProvider: protectedProcedure
      .input(
        z.object({
          provider: z
            .string()
            .trim()
            .refine(isSetupModelProviderId, 'Invalid model provider.'),
          apiKey: z.string().trim().optional(),
          additionalEnvValues: z.record(z.string().trim()).optional(),
          connectionName: z.string().trim().optional(),
          modelId: z.string().trim().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveTaskModelProviderCommand(auth, {
          ...input,
          provider: input.provider,
        }),
      ),

    deleteProvider: protectedProcedure
      .input(
        z.object({
          provider: z
            .string()
            .trim()
            .refine(isSetupModelProviderId, 'Invalid model provider.'),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        deleteTaskModelProviderCommand(auth, {
          provider: input.provider,
        }),
      ),

    discoverProviderModels: protectedProcedure
      .input(
        z.object({
          provider: z
            .string()
            .trim()
            .refine(
              (value) =>
                (LOCAL_TASK_MODEL_PROVIDER_IDS as readonly string[]).includes(
                  value,
                ) || isOpenAiCompatibleProviderId(value),
              'Invalid local model provider.',
            ),
          baseUrl: z.string().trim().optional(),
          apiKey: z.string().trim().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        discoverProviderModelsCommand(auth, {
          ...input,
          provider:
            input.provider as (typeof LOCAL_TASK_MODEL_PROVIDER_IDS)[number],
        }),
      ),

    qualifyProviderModel: protectedProcedure
      .input(
        z.object({
          provider: z
            .string()
            .trim()
            .refine(
              (value) =>
                (LOCAL_TASK_MODEL_PROVIDER_IDS as readonly string[]).includes(
                  value,
                ) || isOpenAiCompatibleProviderId(value),
              'Invalid local model provider.',
            ),
          modelId: z.string().trim().min(1),
          baseUrl: z.string().trim().optional(),
          apiKey: z.string().trim().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        qualifyProviderModelCommand(auth, {
          ...input,
          provider:
            input.provider as (typeof LOCAL_TASK_MODEL_PROVIDER_IDS)[number],
        }),
      ),

    lookup: protectedProcedure
      .input(
        z.object({
          modelId: z.string().trim().min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        lookupTaskModelCommand(auth, input),
      ),

    suggest: protectedProcedure
      .input(
        z.object({
          providerId: z
            .string()
            .trim()
            .refine(isSetupModelProviderId, 'Invalid model provider.'),
          query: z.string().trim(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        suggestTaskModelsCommand(auth, {
          ...input,
          providerId: input.providerId,
        }),
      ),

    refreshMetadata: protectedProcedure.mutation(({ ctx: { auth } }) =>
      refreshTaskModelMetadataCommand(auth),
    ),

    update: protectedProcedure
      .input(
        z.object({
          models: z.array(
            z.object({
              id: z.string().trim().min(1),
              displayName: z.string().trim().min(1),
              family: z.string().trim().min(1).optional(),
              metadata: taskModelMetadataSchema.nullable().optional(),
            }),
          ),
          allowedModelIds: z.array(z.string().trim().min(1)),
          defaultModelId: z.string().trim().min(1),
          orchestrationModelId: z.string().trim().min(1).nullable().optional(),
          helperModelId: z.string().trim().min(1).nullable(),
          visionModelId: z.string().trim().min(1).nullable(),
          codeReviewModelId: z.string().trim().min(1).nullable(),
          exploreModelId: z.string().trim().min(1).nullable().optional(),
          planningModelId: z.string().trim().min(1).nullable(),
          codingModelReasoningEffort: z
            .enum(REASONING_EFFORT_VALUES)
            .nullable(),
          orchestrationModelReasoningEffort: z
            .enum(REASONING_EFFORT_VALUES)
            .nullable()
            .optional(),
          helperModelReasoningEffort: z
            .enum(REASONING_EFFORT_VALUES)
            .nullable(),
          visionModelReasoningEffort: z
            .enum(REASONING_EFFORT_VALUES)
            .nullable(),
          codeReviewModelReasoningEffort: z
            .enum(REASONING_EFFORT_VALUES)
            .nullable(),
          exploreModelReasoningEffort: z
            .enum(REASONING_EFFORT_VALUES)
            .nullable()
            .optional(),
          planningModelReasoningEffort: z
            .enum(REASONING_EFFORT_VALUES)
            .nullable(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updateTaskModelSettingsCommand(auth, input),
      ),
  }),

  chatgptSubscription: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getChatGptSubscriptionStatusCommand(auth),
    ),

    isConnected: protectedProcedure.query(({ ctx: { auth } }) =>
      isChatGptSubscriptionConnectedCommand(auth),
    ),

    startDeviceAuth: protectedProcedure.mutation(({ ctx: { auth } }) =>
      startChatGptDeviceAuthCommand(auth),
    ),

    pollDeviceAuth: protectedProcedure
      .input(
        z.object({
          deviceAuthId: z.string().min(1),
          userCode: z.string().min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        pollChatGptDeviceAuthCommand(auth, input),
      ),

    disconnect: protectedProcedure.mutation(({ ctx: { auth } }) =>
      disconnectChatGptSubscriptionCommand(auth),
    ),

    updateFastMode: protectedProcedure
      .input(z.object({ fastMode: z.boolean() }))
      .mutation(({ ctx: { auth }, input }) =>
        updateChatGptSubscriptionFastModeCommand(auth, input),
      ),
  }),

  githubCopilotSubscription: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getGitHubCopilotSubscriptionStatusCommand(auth),
    ),
    isConnected: protectedProcedure.query(({ ctx: { auth } }) =>
      isGitHubCopilotSubscriptionConnectedCommand(auth),
    ),
    startDeviceAuth: protectedProcedure.mutation(({ ctx: { auth } }) =>
      startGitHubCopilotDeviceAuthCommand(auth),
    ),
    pollDeviceAuth: protectedProcedure
      .input(z.object({ deviceCode: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        pollGitHubCopilotDeviceAuthCommand(auth, input),
      ),
    disconnect: protectedProcedure.mutation(({ ctx: { auth } }) =>
      disconnectGitHubCopilotSubscriptionCommand(auth),
    ),
  }),

  xaiSubscription: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getXaiSubscriptionStatusCommand(auth),
    ),
    isConnected: protectedProcedure.query(({ ctx: { auth } }) =>
      isXaiSubscriptionConnectedCommand(auth),
    ),
    startDeviceAuth: protectedProcedure.mutation(({ ctx: { auth } }) =>
      startXaiDeviceAuthCommand(auth),
    ),
    pollDeviceAuth: protectedProcedure
      .input(z.object({ deviceCode: z.string().min(1) }))
      .mutation(({ ctx: { auth }, input }) =>
        pollXaiDeviceAuthCommand(auth, input),
      ),
    disconnect: protectedProcedure.mutation(({ ctx: { auth } }) =>
      disconnectXaiSubscriptionCommand(auth),
    ),
  }),

  subscriptionUsage: createRouter({
    list: protectedProcedure.query(({ ctx: { auth } }) =>
      getSubscriptionProviderUsageCommand(auth),
    ),
  }),

  providerCredits: createRouter({
    list: protectedProcedure.query(({ ctx: { auth } }) =>
      getProviderCreditBalancesCommand(auth),
    ),
  }),

  routerDebug: createRouter({
    getSettings: protectedProcedure.query(({ ctx: { auth } }) =>
      getRouterDebugSettingsCommand(auth),
    ),

    updateSettings: protectedProcedure
      .input(
        z.object({
          provider: z
            .enum(['slack', 'teams', 'telegram', 'discord'])
            .nullable(),
          channelId: z.string().trim().min(1).max(255).nullable(),
          disabled: z.boolean(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updateRouterDebugSettingsCommand(auth, input),
      ),
  }),

  setup: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getSetupStatusCommand(auth),
    ),

    batchCreateEnvironments: protectedProcedure
      .input(
        z.object({
          environments: z
            .array(
              z.object({
                name: z.string().min(1).max(100),
                repositoryIds: z.array(z.string().uuid()).min(1),
                installCommand: z.string().max(500).optional(),
                testCommand: z.string().max(500).optional(),
              }),
            )
            .min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        batchCreateEnvironmentsCommand(auth, input),
      ),

    autoCreateAgents: protectedProcedure.mutation(({ ctx: { auth } }) =>
      autoCreateAgentsCommand(auth),
    ),

    complete: protectedProcedure
      .input(
        z
          .object({
            anonymousAnalyticsEnabled: z.boolean().optional(),
            productUpdatesEnabled: z.boolean().optional(),
          })
          .optional(),
      )
      .mutation(({ ctx: { auth }, input }) =>
        completeSetupCommand(auth, input),
      ),

    completeWithStarterTasks: protectedProcedure
      .input(
        z.object({
          launchBatchId: z.string().uuid(),
          selectedStarterTaskIds: z
            .array(z.enum(SETUP_STARTER_TASK_IDS))
            .max(SETUP_STARTER_TASK_IDS.length),
          anonymousAnalyticsEnabled: z.boolean().optional(),
          productUpdatesEnabled: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        completeSetupWithStarterTasksCommand(auth, input),
      ),
  }),

  setupNew: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getSetupNewStatusCommand(auth),
    ),

    trackWelcomeSeen: protectedProcedure.mutation(({ ctx: { auth } }) =>
      trackSetupWelcomeSeenCommand(auth),
    ),

    trackCommsState: protectedProcedure
      .input(
        z.object({
          provider: z.enum(['microsoft', 'telegram', 'discord']),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        trackSetupCommsStateCommand(auth, input),
      ),

    saveAuthProviderChoice: protectedProcedure
      .input(
        z.object({
          provider: z.enum(SETUP_AUTH_PROVIDER_IDS),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSetupNewAuthProviderChoiceCommand(auth, input),
      ),

    saveAuthConfig: protectedProcedure
      .input(
        z.object({
          provider: z.enum(SETUP_AUTH_PROVIDER_IDS),
          values: z.record(z.string().trim()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSetupNewAuthConfigCommand(auth, input),
      ),

    saveModelConfig: protectedProcedure
      .input(
        z.object({
          provider: z
            .string()
            .trim()
            .refine(isSetupModelProviderId, 'Invalid model provider.'),
          apiKey: z.string().trim().optional(),
          additionalEnvValues: z.record(z.string().trim()).optional(),
          connectionName: z.string().trim().optional(),
          modelId: z.string().trim().optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSetupNewModelConfigCommand(auth, {
          ...input,
          provider: input.provider,
        }),
      ),

    chooseTrialInference: protectedProcedure.mutation(({ ctx: { auth } }) =>
      chooseSetupTrialInferenceCommand(auth),
    ),

    saveComputeProviderChoice: protectedProcedure
      .input(
        z.object({
          provider: z.enum(computeProviders),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSetupNewComputeProviderChoiceCommand(auth, input),
      ),

    saveComputeConfig: protectedProcedure
      .input(
        z.object({
          provider: z.enum(computeProviders),
          values: z.record(z.string().trim()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSetupNewComputeConfigCommand(auth, input),
      ),

    saveSourceControlProviderChoice: protectedProcedure
      .input(
        z.object({
          provider: sourceControlProviderSchema,
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSetupNewSourceControlProviderChoiceCommand(auth, input),
      ),

    saveSourceControlConfig: protectedProcedure
      .input(
        z.object({
          provider: sourceControlProviderSchema,
          values: z.record(z.string().trim()).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSetupNewSourceControlConfigCommand(auth, input),
      ),

    saveQueuedTasks: protectedProcedure
      .input(
        z.object({
          selectedSuggestionIds: z.array(z.string().uuid()).max(5),
          customTaskPrompt: z.string().trim().max(4_000).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveSetupNewQueuedTasksCommand(auth, input),
      ),

    ensureDefaultAgents: protectedProcedure.mutation(({ ctx: { auth } }) =>
      ensureSetupNewDefaultAgentsCommand(auth),
    ),
  }),

  setupBootstrap: createRouter({
    status: publicProcedure
      .input(
        z
          .object({
            setupToken: z.string().optional(),
          })
          .optional(),
      )
      .query(({ input }) => getSetupBootstrapStatusCommand(input)),

    trackWelcomeSeen: publicProcedure
      .input(
        z
          .object({
            setupToken: z.string().optional(),
          })
          .optional(),
      )
      .mutation(({ input }) => trackSetupBootstrapWelcomeSeenCommand(input)),

    saveAuthProviderChoice: publicProcedure
      .input(
        z.object({
          provider: z.enum(SETUP_AUTH_PROVIDER_IDS),
          setupToken: z.string().optional(),
        }),
      )
      .mutation(({ input }) =>
        saveSetupBootstrapAuthProviderChoiceCommand(input),
      ),

    saveAuthConfig: publicProcedure
      .input(
        z.object({
          provider: z.enum(SETUP_AUTH_PROVIDER_IDS),
          values: z.record(z.string().trim()).optional(),
          setupToken: z.string().optional(),
        }),
      )
      .mutation(({ input }) => saveSetupBootstrapAuthConfigCommand(input)),

    createSlackAppFromManifest: publicProcedure
      .input(
        z.object({
          configToken: z.string().trim().min(1),
          setupToken: z.string().optional(),
        }),
      )
      .mutation(({ input }) =>
        createSetupBootstrapSlackAppFromManifestCommand(input),
      ),
  }),

  deployment: createRouter({
    // Public: pre-auth pages call this to detect a canonical-origin
    // mismatch before auth requests fail. Reveals nothing beyond what a
    // probing request to the auth endpoints would observe.
    assessBrowserOrigin: publicProcedure
      .input(
        z.object({
          browserOrigin: z.string().max(2048),
        }),
      )
      .query(({ input }) => assessBrowserOriginCommand(input)),
  }),

  onboarding: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getOnboardingStatusCommand(auth),
    ),

    complete: protectedProcedure
      .input(
        z
          .object({
            productUpdatesEnabled: z.boolean().optional(),
          })
          .optional(),
      )
      .mutation(({ ctx: { auth }, input }) =>
        completeOnboardingCommand(auth, input),
      ),
  }),

  taskSuggestions: createRouter({
    list: protectedProcedure.query(({ ctx: { auth } }) =>
      listTaskSuggestionsCommand(auth),
    ),

    history: protectedProcedure
      .input(
        z.object({
          limit: z.number().int().min(1).max(30).default(30),
          cursor: z.string().optional(),
          automation: z
            .enum([
              'onboarding',
              'suggest_ideas',
              'sentry_triage',
              'dependabot_triage',
              'codeql_triage',
              'security_auditor',
              'code_quality_auditor',
            ])
            .optional(),
          repository: z.string().optional(),
          status: z.enum(['proposed', 'accepted', 'ignored', 'all']).optional(),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        listTaskSuggestionHistoryCommand(auth, input),
      ),

    filterOptions: protectedProcedure.query(({ ctx: { auth } }) =>
      getTaskSuggestionFilterOptionsCommand(auth),
    ),

    trigger: protectedProcedure.mutation(({ ctx: { auth } }) =>
      triggerTaskSuggestionsCommand(auth),
    ),

    dismiss: protectedProcedure
      .input(
        z.object({
          suggestionId: z.string().uuid(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        dismissTaskSuggestionCommand(auth, input),
      ),

    implement: protectedProcedure
      .input(
        z.object({
          suggestionId: z.string().uuid(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        implementTaskSuggestionCommand(auth, input),
      ),
  }),

  backgroundAgents: automationsRouter,
  automations: automationsRouter,

  fastSessions: createRouter({
    start: protectedProcedure
      .input(startFastSessionInputSchema)
      .mutation(({ ctx: { auth }, input }) =>
        startFastSessionCommand(auth, input),
      ),

    reply: protectedProcedure
      .input(replyToFastSessionInputSchema)
      .mutation(({ ctx: { auth }, input }) =>
        replyToFastSessionCommand(auth, input),
      ),
  }),

  agentBehavior: createRouter({
    get: protectedProcedure.query(({ ctx: { auth } }) =>
      getAgentBehaviorSettingsCommand(auth),
    ),

    update: protectedProcedure
      .input(
        z
          .object({
            globalAgentInstructions: z.string().max(10_000).nullable(),
          })
          .partial(),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updateAgentBehaviorSettingsCommand(auth, input),
      ),
  }),

  accessPolicy: createRouter({
    get: protectedProcedure.query(({ ctx: { auth } }) =>
      getAccessPolicySettingsCommand(auth),
    ),

    accountLinkHelp: protectedProcedure.query(({ ctx: { auth } }) =>
      getAccountLinkHelpCommand(auth),
    ),

    setAccountLinkHelp: protectedProcedure
      .input(
        z.object({
          helpText: z.string().trim().max(1000).nullable(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        setAccountLinkHelpCommand(auth, input),
      ),

    createInvite: protectedProcedure
      .input(
        z.object({
          label: z.string().trim().max(200).optional(),
          role: z.enum(['admin', 'member']).optional(),
          maxUses: z.number().int().min(1).max(1000).optional(),
          expiresInDays: z.number().int().min(1).max(365).nullish(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) => createInviteCommand(auth, input)),

    revokeInvite: protectedProcedure
      .input(
        z.object({
          inviteId: z.string().uuid(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) => revokeInviteCommand(auth, input)),

    updateUserRole: protectedProcedure
      .input(
        z.object({
          userId: z.string().min(1),
          role: z.enum(['admin', 'member']),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updateUserRoleCommand(auth, input),
      ),

    removeUser: protectedProcedure
      .input(
        z.object({
          userId: z.string().min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) => removeUserCommand(auth, input)),

    createPasswordResetLink: protectedProcedure
      .input(
        z.object({
          userId: z.string().min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        createPasswordResetLinkCommand(auth, input),
      ),

    setLicenseKey: protectedProcedure
      .input(
        z.object({
          licenseKey: z.string().trim().max(10_000).nullable(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        setLicenseKeyCommand(auth, input),
      ),
  }),

  customSkills: createRouter({
    list: protectedProcedure.query(({ ctx: { auth } }) =>
      listCustomSkillsCommand(auth),
    ),

    search: protectedProcedure
      .input(
        z.object({
          query: z.string().max(200),
        }),
      )
      .query(({ ctx: { auth }, input }) =>
        searchCustomSkillsCommand(auth, input),
      ),

    setAvailability: protectedProcedure
      .input(
        z.object({
          skillId: z.string().min(3),
          environmentIds: z.array(z.string().uuid()).min(1),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        setCustomSkillAvailabilityCommand(auth, input),
      ),

    saveManual: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          description: z.string().min(1),
          content: z.string().min(1),
          environmentIds: z.array(z.string().uuid()).min(1),
          previousSkillId: z.string().min(3).optional(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        saveManualSkillCommand(auth, input),
      ),

    remove: protectedProcedure
      .input(
        z.object({
          skillId: z.string().min(3),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        removeCustomSkillCommand(auth, input),
      ),
  }),

  featureFlags: createRouter({
    getExperimental: protectedProcedure.query(({ ctx: { auth } }) =>
      getExperimentalFlagsCommand(auth),
    ),

    setExperimental: protectedProcedure
      .input(
        z.object({
          flag: z.nativeEnum(FeatureFlag),
          value: z.boolean(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        updateExperimentalFlagCommand(auth, input),
      ),
  }),

  brain: createRouter({
    get: protectedProcedure.query(({ ctx: { auth } }) =>
      getBrainSettingsCommand(auth),
    ),

    listPages: protectedProcedure
      .input(
        z.object({
          search: z.string().max(200).optional(),
          namespaceId: z.string().max(100).optional(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(100).default(100),
        }),
      )
      .query(({ ctx: { auth }, input }) => listBrainPagesCommand(auth, input)),

    getPage: protectedProcedure
      .input(z.object({ slug: z.string().min(1).max(512) }))
      .query(({ ctx: { auth }, input }) => getBrainPageCommand(auth, input)),

    backfillTaskMemories: protectedProcedure.mutation(({ ctx: { auth } }) =>
      backfillBrainTaskMemoriesCommand(auth),
    ),

    retryFailedTaskMemories: protectedProcedure.mutation(({ ctx: { auth } }) =>
      retryFailedBrainTaskMemoriesCommand(auth),
    ),
  }),

  miscSettings: createRouter({
    get: protectedProcedure.query(({ ctx: { auth } }) =>
      getMiscSettingsCommand(auth),
    ),

    setAnonymousAnalytics: protectedProcedure
      .input(
        z.object({
          enabled: z.boolean(),
        }),
      )
      .mutation(({ ctx: { auth }, input }) =>
        setAnonymousAnalyticsCommand(auth, input),
      ),
    setTimeZone: protectedProcedure
      .input(z.object({ timeZone: z.string().trim().min(1).max(100) }))
      .mutation(({ ctx: { auth }, input }) =>
        setDeploymentTimeZoneCommand(auth, input),
      ),
  }),

  releases: createRouter({
    status: protectedProcedure.query(({ ctx: { auth } }) =>
      getReleaseStatusCommand(auth),
    ),
    notes: protectedProcedure
      .input(
        z.object({
          version: z.string().min(1).max(64),
        }),
      )
      .query(({ ctx: { auth }, input }) => getReleaseNotesCommand(auth, input)),
  }),
});

export type AppRouter = typeof appRouter;

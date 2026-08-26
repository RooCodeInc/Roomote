import { TRPCError } from '@trpc/server';
import { enqueueTask } from '@roomote/cloud-agents/server';
import { resolveEnvironmentSourceControlProvider } from '@/lib/server/source-control-provider';
import {
  captureActivationAutomationChanged,
  captureTaskSettled,
} from '@roomote/telemetry/server';
import {
  db,
  deploymentSettings,
  environments,
  environmentVariables,
  workItems,
  pullRequestFacts,
  slackInstallations,
  slackUserMappings,
  asc,
  eq,
  gte,
  and,
  inArray,
  isNull,
  sql,
  cancelTaskRunDirect,
  claimWorkItem,
  finalizeWorkItemLaunched,
  releaseWorkItemClaim,
  WORK_ITEM_LAUNCH_STALE_CLAIM_MS,
  resolveDeploymentEnvVar,
  purgeSavedDeploymentWorkerImage,
  invalidateTelegramRuntimeCredentialsCache,
  invalidateTeamsBotRuntimeCredentialsCache,
  isChatGptSubscriptionConnected,
  isGitHubCopilotSubscriptionConnected,
  isXaiSubscriptionConnected,
  type DatabaseOrTransaction,
  upsertAutomation,
  createCustomAutomation,
  updateCustomAutomation,
  getCustomAutomationById,
} from '@roomote/db/server';
import {
  AUTOMATION_RECOMMENDATION_REPOSITORY_CAP,
  buildAutomationRecommendationFingerprint,
  enqueueAutomationRecommendationInitialRun,
  enqueueAutomationRecommendations,
} from '@roomote/sdk/server';
import {
  buildRecommendedDeploymentModelConfig,
  buildTaskModelOption,
  buildSetupAuthStatus,
  buildSetupComputeStatus,
  buildSetupModelStatus,
  buildSetupSourceControlStatus,
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  collectSetupModelProviderCredentialValues,
  createEmptyDeploymentModelConfig,
  createEmptySetupNewState,
  TaskPayloadKind,
  type ComputeProvider,
  assertUniqueRepositoryFullNames,
  type DeploymentModelConfig,
  deriveWorkerImageFromReleaseVersion,
  getSetupAuthProvider,
  getSetupComputeProvider,
  getComputeFieldValidationError,
  getSetupModelProvider,
  getSetupModelProviderAdditionalEnvFields,
  SETUP_MODEL_PROVIDER_CATALOG,
  buildOpenAiCompatibleProviderId,
  buildOpenAiCompatibleProviderInstance,
  isOpenAiCompatibleProviderId,
  normalizeOpenAiCompatibleConnectionSlug,
  isAutoProvisionedComputeArtifactField,
  isComputeCredentialField,
  isComputeInfrastructureField,
  isConfiguredEnvValue,
  isRequiredComputeField,
  normalizeTaskModelSettings,
  DEFAULT_TASK_MODEL_SETTINGS,
  NON_SECRET_AUTH_ENV_VAR_NAMES,
  NON_SECRET_COMPUTE_ENV_VAR_NAMES,
  NON_SECRET_SOURCE_CONTROL_ENV_VAR_NAMES,
  normalizeDeploymentComputeConfig,
  normalizeDeploymentModelConfig,
  getSetupNewComputeProvisioningState,
  hasSetupChatHandoffDestination,
  isSetupProvisionableComputeProvider,
  normalizeSetupNewState,
  presentSetupNewComputeProvisioning,
  resolveDerivedModalBaseImageRef,
  resolveTeamsBotCredentialEnvVarNames,
  SETUP_COMPUTE_PROVISIONING_STATE_FIELDS,
  SHARED_WORKER_IMAGE_ENV_VAR,
  type SetupAuthProviderId,
  type AutomationRecommendationBatch,
  type SetupComputeStatus,
  type SetupModelProviderId,
  type SetupProvisionableComputeProvider,
  type SourceControlProvider,
  type TaskModelSettings,
  AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
  AUTOMATION_RECOMMENDATION_CATALOG,
  ALL_REPOSITORIES,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import {
  evaluateSetupFunnelMilestones,
  recordSetupFunnelMilestones,
} from '@/lib/server/setup-funnel-telemetry';
import {
  assertSetupTokenValid,
  getLatestTaskRunsByTaskId,
  getRepositories,
  getRequestInviteToken,
  getSourceControlConnectionSummary,
  isSetupTokenRequired,
  isSetupTokenValid,
} from '@/lib/server';
import {
  findMatchingSetupNewEnvironment,
  isSetupNewOnboardingFailureStatus,
  isSetupNewOnboardingSuccessStatus,
  isSetupNewOnboardingTerminalSuccessStatus,
  normalizeRepositorySelection,
} from '@/lib/setup-new';
import type { QueuedOnboardingTask } from './types';
import {
  getLinkedDiscordAccountCommand,
  getLinkedTelegramAccountCommand,
} from '../linked-accounts';
import { getTeamsIntegrationStatusCommand } from '../teams';

import {
  assertAdmin,
  getSetupBootstrapState,
  ensureDefaultSetupAgents,
  getSetupBaseStatus,
} from '../setup/shared';
import {
  getPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues,
  upsertDeploymentEnvironmentVariables,
} from '../environment-variables';
import {
  assertTeamsBotCredentialsAuthenticate,
  invalidateTeamsBotCredentialCheckCache,
} from '../teams/bot-credential-check';
import {
  getPersistedRuntimeComputeConfig,
  savePersistedRuntimeComputeConfig,
} from '../compute';
import {
  acquireComputeProvisioningLock,
  createPendingComputeProvisioning,
  prepareComputeProvisioningStart,
  runComputeProvisioning,
} from '../compute/compute-provisioning';
import { createSlackAppFromManifest } from '../slack/create-app-from-manifest';
import {
  assertValidSourceControlConfigInput,
  saveSourceControlConfigValues,
} from '../source-control';
import { getPersistedRawTaskModelSettings } from '../task-models';
import {
  buildAutoAddedTaskModelSettings,
  collectConnectedTaskModelProviderIds,
} from '../task-models/auto-add-models';
import { validateSetupModelProviderCredentials } from '../task-models/provider-validation';
import { triggerTaskSuggestionsCommand } from '../task-suggestions';
import { triggerAutomationCommand } from '../automations/trigger-agent';
import { triggerCustomAutomationCommand } from '../automations/custom-automations';

type PersistedSetupNewState = ReturnType<typeof createEmptySetupNewState>;
type PersistedRuntimeModelConfig = DeploymentModelConfig;
const AUTOMATION_RECOMMENDATION_TRIGGER_DELAY_MS = 5 * 60 * 1_000;

type SelectedRepositorySummary = {
  id: string;
  fullName: string;
  sourceControlProvider: SourceControlProvider;
};

type PersistedQueuedSetupTask = QueuedOnboardingTask;

type MutableQueuedSetupTask = PersistedQueuedSetupTask & {
  launchClaimedAt: Date | null;
};

async function assertSetupBootstrapOpen() {
  const bootstrapState = await getSetupBootstrapState();

  if (!bootstrapState.setupOpen) {
    throw new Error('Initial setup is no longer open.');
  }
}

async function getPersistedSetupNewState(
  executor: DatabaseOrTransaction = db,
): Promise<PersistedSetupNewState> {
  const [settings] = await executor
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);

  return normalizeSetupNewState(settings?.setupNewState ?? {});
}

async function getPersistedRuntimeModelConfig(
  executor: DatabaseOrTransaction = db,
): Promise<PersistedRuntimeModelConfig> {
  const [settings] = await executor
    .select({ runtimeModelConfig: deploymentSettings.runtimeModelConfig })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);

  return normalizeDeploymentModelConfig(settings?.runtimeModelConfig);
}

async function savePersistedSetupNewState(
  setupNewState: PersistedSetupNewState,
  executor: DatabaseOrTransaction = db,
) {
  await executor
    .insert(deploymentSettings)
    .values({
      id: 'default',
      setupNewState,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        setupNewState,
        updatedAt: new Date(),
      },
    });

  return setupNewState;
}

async function savePersistedRuntimeModelConfig(
  runtimeModelConfig: PersistedRuntimeModelConfig,
  executor: DatabaseOrTransaction = db,
) {
  await executor
    .insert(deploymentSettings)
    .values({
      id: 'default',
      runtimeModelConfig,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        runtimeModelConfig,
        updatedAt: new Date(),
      },
    });

  return runtimeModelConfig;
}

async function savePersistedTaskModelSettings(
  taskModelSettings: TaskModelSettings,
  executor: DatabaseOrTransaction = db,
) {
  await executor
    .insert(deploymentSettings)
    .values({
      id: 'default',
      taskModelSettings,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        taskModelSettings,
        updatedAt: new Date(),
      },
    });

  return taskModelSettings;
}

// Persisted runtime compute config helpers are shared with the compute
// settings commands and imported from '../compute'.

/**
 * Free-trial inference. A hosting provisioner can inject a capped,
 * Roomote-minted OpenRouter key as `R_TRIAL_OPENROUTER_API_KEY`. The setup
 * wizard's inference step then offers "start with free credits" alongside
 * connecting a provider; choosing it applies OpenRouter's "Efficient" preset
 * as ordinary editable config, so first tasks run on an inexpensive default
 * and every model and provider control keeps working because nothing is
 * pinned through env.
 *
 * This is an explicit operator choice, never an automatic seed: the command
 * no-ops once any inference choice exists (a selected provider, saved model
 * config, or task model settings) and refuses when a real provider is
 * already connected, so it can never overwrite configuration.
 */
const TRIAL_PRESET_ID = 'efficient';

export async function chooseSetupTrialInferenceCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const { userId } = auth;

  if (!isConfiguredEnvValue(process.env.R_TRIAL_OPENROUTER_API_KEY)) {
    throw new Error(
      'Free trial inference is not available on this deployment.',
    );
  }

  return db.transaction(async (tx) => {
    // Serialize against concurrent configuration writes: every check below
    // must observe the row state the upserts will replace, or an operator's
    // save landing between read and write would be overwritten.
    await tx
      .insert(deploymentSettings)
      .values({ id: 'default' })
      .onConflictDoNothing();
    await tx
      .select({ id: deploymentSettings.id })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .for('update');

    const [
      currentState,
      persistedModelConfig,
      persistedTaskModelSettings,
      persistedEnvVarNames,
      chatgptConnected,
      githubCopilotConnected,
      xaiSubscriptionConnected,
    ] = await Promise.all([
      getPersistedSetupNewState(tx),
      getPersistedRuntimeModelConfig(tx),
      getPersistedRawTaskModelSettings(tx),
      getPersistedEnvironmentVariableNames(tx),
      isChatGptSubscriptionConnected(),
      isGitHubCopilotSubscriptionConnected(),
      isXaiSubscriptionConnected(),
    ]);

    // Any prior inference choice wins: a repeat click (or a stale wizard tab)
    // must not reset models an operator has since adjusted.
    const hasModelChoices =
      currentState.modelProvider !== null ||
      persistedTaskModelSettings !== null ||
      Object.values(persistedModelConfig).some((value) => value !== null);

    if (hasModelChoices) {
      return {
        setupNewState: currentState,
        runtimeModelConfig: persistedModelConfig,
      };
    }

    const status = buildSetupModelStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      chatgptConnected,
      githubCopilotConnected,
      xaiSubscriptionConnected,
    });
    const hasOperatorProvider = status.providers.some(
      (provider) =>
        provider.savedApiKeySatisfied ||
        (provider.runtimeApiKeySatisfied && !provider.trialKeySatisfied),
    );

    if (hasOperatorProvider) {
      throw new Error(
        'A model provider is already connected, so the free trial is not needed.',
      );
    }

    const provider = getSetupModelProvider('openrouter');
    const runtimeModelConfig = buildRecommendedDeploymentModelConfig(
      provider,
      TRIAL_PRESET_ID,
    );
    const defaultModelId = runtimeModelConfig.roomoteModel;
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      modelProvider: provider.id,
      lastInteractedByUserId: userId,
    });

    await Promise.all([
      savePersistedSetupNewState(setupNewState, tx),
      savePersistedRuntimeModelConfig(runtimeModelConfig, tx),
      savePersistedTaskModelSettings(
        normalizeTaskModelSettings({
          ...DEFAULT_TASK_MODEL_SETTINGS,
          ...(defaultModelId ? { defaultModelId } : {}),
        }),
        tx,
      ),
    ]);

    return { setupNewState, runtimeModelConfig };
  });
}

async function resolveSelectedRepositories(repositoryIds: string[]): Promise<{
  normalizedRepositoryIds: string[];
  selectedRepositories: SelectedRepositorySummary[];
}> {
  const uniqueRepositoryIds = [...new Set(repositoryIds)];
  const availableRepositories = await getRepositories();
  const availableRepositoriesById = new Map(
    availableRepositories.map((repository) => [repository.id, repository]),
  );
  const selectedRepositories: SelectedRepositorySummary[] = [];

  for (const repositoryId of uniqueRepositoryIds) {
    const repository = availableRepositoriesById.get(repositoryId);

    if (!repository) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Selected repositories are no longer available.',
      });
    }

    selectedRepositories.push({
      id: repository.id,
      fullName: repository.fullName,
      sourceControlProvider: repository.sourceControlProvider,
    });
  }

  try {
    assertUniqueRepositoryFullNames(
      selectedRepositories.map((repository) => repository.fullName),
    );
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        error instanceof Error
          ? error.message
          : 'The selected repositories are invalid.',
      cause: error,
    });
  }

  return {
    normalizedRepositoryIds: normalizeRepositorySelection(selectedRepositories),
    selectedRepositories,
  };
}

async function resolveConnectedRecommendationRepositories(): Promise<{
  normalizedRepositoryIds: string[];
  connectedRepositories: SelectedRepositorySummary[];
}> {
  const availableRepositories = await getRepositories();
  const connectedRepositories = availableRepositories.map((repository) => ({
    id: repository.id,
    fullName: repository.fullName,
    sourceControlProvider: repository.sourceControlProvider,
  }));
  const activitySince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const activityRows =
    connectedRepositories.length > 0
      ? await db
          .select({
            repositoryId: pullRequestFacts.repositoryId,
            activity: sql<number>`count(*)::int`,
          })
          .from(pullRequestFacts)
          .where(
            and(
              inArray(
                pullRequestFacts.repositoryId,
                connectedRepositories.map((repository) => repository.id),
              ),
              gte(pullRequestFacts.updatedAtRemote, activitySince),
            ),
          )
          .groupBy(pullRequestFacts.repositoryId)
      : [];
  const activityByRepositoryId = new Map(
    activityRows.map((row) => [row.repositoryId, row.activity]),
  );
  const rankedRepositories = [...connectedRepositories]
    .sort((left, right) => {
      const activityDifference =
        (activityByRepositoryId.get(right.id) ?? 0) -
        (activityByRepositoryId.get(left.id) ?? 0);
      return activityDifference || left.fullName.localeCompare(right.fullName);
    })
    .slice(0, AUTOMATION_RECOMMENDATION_REPOSITORY_CAP);

  return {
    normalizedRepositoryIds: normalizeRepositorySelection(rankedRepositories),
    connectedRepositories: rankedRepositories,
  };
}

async function getActiveSlackInstallation(
  executor: DatabaseOrTransaction = db,
) {
  const [installation] = await executor
    .select({
      botAccessToken: slackInstallations.botAccessToken,
      teamId: slackInstallations.teamId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  return installation ?? null;
}

async function getSlackUserMappingForTeam(
  input: {
    userId: string;
    teamId: string;
  },
  executor: DatabaseOrTransaction = db,
) {
  const [mapping] = await executor
    .select({
      slackUserId: slackUserMappings.slackUserId,
    })
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.userId, input.userId),
        eq(slackUserMappings.slackTeamId, input.teamId),
      ),
    )
    .limit(1);

  return mapping ?? null;
}

async function getSetupSlackAccessStatus(
  input: {
    userId: string;
  },
  executor: DatabaseOrTransaction = db,
) {
  const installation = await getActiveSlackInstallation(executor);

  if (!installation) {
    return {
      hasSlackInstallation: false,
      hasSlackUserMapping: false,
    };
  }

  const mapping = await getSlackUserMappingForTeam(
    {
      userId: input.userId,
      teamId: installation.teamId,
    },
    executor,
  );

  return {
    hasSlackInstallation: true,
    hasSlackUserMapping: mapping !== null,
  };
}

async function getOnboardingTaskState(taskId: string | null) {
  if (!taskId) {
    return {
      status: null,
      taskPhase: null,
      firstAssistantOutputAt: null,
    };
  }

  const latestTaskRuns = await getLatestTaskRunsByTaskId([taskId]);
  const latestRun = latestTaskRuns[taskId];

  return {
    status: latestRun?.status ?? null,
    taskPhase: latestRun?.taskPhase ?? null,
    firstAssistantOutputAt: latestRun?.firstAssistantOutputAt ?? null,
  };
}

function findAvailableSetupComputeProvider(
  computeSetup: SetupComputeStatus,
  provider: ComputeProvider,
) {
  if (computeSetup.excludedProviders?.includes(provider)) {
    return undefined;
  }

  return computeSetup.providers.find(
    (candidate) => candidate.provider === provider,
  );
}

async function getPersistedTaskSuggestionRows(suggestionIds?: string[]) {
  if (suggestionIds && suggestionIds.length === 0) {
    return [];
  }

  return db
    .select({
      id: workItems.id,
      title: workItems.title,
      brief: workItems.brief,
      sortOrder: workItems.sortOrder,
    })
    .from(workItems)
    .where(
      suggestionIds
        ? and(
            eq(workItems.kind, 'suggestion'),
            inArray(workItems.id, suggestionIds),
          )
        : eq(workItems.kind, 'suggestion'),
    )
    .orderBy(asc(workItems.sortOrder));
}

async function getPersistedQueuedSetupTasks(
  setupOnboardingTaskId: string | null,
  executor: DatabaseOrTransaction = db,
): Promise<PersistedQueuedSetupTask[]> {
  if (!setupOnboardingTaskId) {
    return [];
  }

  return executor
    .select({
      id: workItems.id,
      suggestionId: workItems.sourceWorkItemId,
      title: workItems.title,
      prompt: workItems.executionPrompt,
      sortOrder: workItems.sortOrder,
      launchedTaskId: workItems.launchedTaskId,
      launchedAt: workItems.launchedAt,
      environmentId: workItems.targetEnvironmentId,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.sourceTaskId, setupOnboardingTaskId),
        eq(workItems.kind, 'onboarding'),
      ),
    )
    .orderBy(asc(workItems.sortOrder));
}

async function getMutableQueuedSetupTasks(
  setupOnboardingTaskId: string,
  executor: DatabaseOrTransaction = db,
): Promise<MutableQueuedSetupTask[]> {
  return executor
    .select({
      id: workItems.id,
      suggestionId: workItems.sourceWorkItemId,
      title: workItems.title,
      prompt: workItems.executionPrompt,
      sortOrder: workItems.sortOrder,
      launchedTaskId: workItems.launchedTaskId,
      launchedAt: workItems.launchedAt,
      environmentId: workItems.targetEnvironmentId,
      launchClaimedAt: workItems.launchClaimedAt,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.sourceTaskId, setupOnboardingTaskId),
        eq(workItems.kind, 'onboarding'),
      ),
    )
    .orderBy(asc(workItems.sortOrder));
}

/**
 * Mirrors a launched onboarding copy back onto its source suggestion so the
 * suggestions UI shows the suggestion as launched once its queued onboarding
 * copy launches. This is a status *mirror*, not a launch of its own, so it must
 * never stomp a live claim held by another surface.
 *
 * It goes through the shared fenced CAS: `claimWorkItem` the suggestion, and
 * only `finalizeWorkItemLaunched` when the claim succeeded. When another surface
 * (e.g. web-implement) already holds a fresh claim, or the suggestion is already
 * `launched`, the claim returns null and the mirror is skipped — never
 * overwriting that surface's status/token.
 *
 * `dismissed` is opted into the claimable set (matching the web-implement
 * surface in task-suggestions/implement.ts) with `clearDismissedAt`, so a
 * suggestion that was dismissed after being queued still flips to `launched`
 * when its onboarding copy launches. That is the least-surprising state: the
 * work genuinely launched, so the suggestions UI should reflect it rather than
 * showing the row as merely dismissed.
 *
 * The claim and finalize run in one transaction so a finalize failure rolls the
 * claim back rather than stranding the suggestion in `launching` with a live
 * claim until the 10-minute stale-claim recovery.
 */
async function markSuggestionWorkItemLaunched(
  input: {
    suggestionId: string;
    launchedTaskId: string;
  },
  executor: DatabaseOrTransaction = db,
) {
  await executor.transaction(async (tx) => {
    const claimedSuggestion = await claimWorkItem(tx, {
      id: input.suggestionId,
      additionalClaimableStatuses: ['dismissed'],
      extraConditions: [eq(workItems.kind, 'suggestion')],
    });

    if (!claimedSuggestion) {
      // Another surface holds a fresh claim, the suggestion already launched, or
      // it is terminally failed. Skip the mirror rather than overwrite it.
      console.warn(
        `[setup-new] Skipped mirroring launched state onto suggestion ${input.suggestionId}: it is already launched or another surface holds a fresh claim.`,
      );
      return;
    }

    const finalized = await finalizeWorkItemLaunched(tx, {
      id: input.suggestionId,
      taskId: input.launchedTaskId,
      claimedAt: claimedSuggestion.launchClaimedAt,
      clearDismissedAt: true,
    });

    if (!finalized) {
      // Our claim token was superseded between claim and finalize; leave the new
      // claimant's state untouched.
      console.warn(
        `[setup-new] Suggestion ${input.suggestionId} mirror lost the fencing guard after claiming; another surface reclaimed it. Leaving its state untouched.`,
      );
    }
  });
}

function stripMutableQueuedSetupTask(
  queuedTask: MutableQueuedSetupTask,
): PersistedQueuedSetupTask {
  const { launchClaimedAt: _launchClaimedAt, ...persistedQueuedTask } =
    queuedTask;

  return persistedQueuedTask;
}

function buildCustomQueuedTaskTitle(prompt: string) {
  const firstMeaningfulLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstMeaningfulLine) {
    return 'Custom task';
  }

  // Persist a fuller title in storage; the pill strip truncates further for display.
  return firstMeaningfulLine.length <= 120
    ? firstMeaningfulLine
    : `${firstMeaningfulLine.slice(0, 117)}...`;
}

async function replaceQueuedSetupTasks({
  setupOnboardingTaskId,
  selectedByUserId,
  selectedSuggestionIds,
  customTaskPrompt,
}: {
  setupOnboardingTaskId: string;
  selectedByUserId: string;
  selectedSuggestionIds: string[];
  customTaskPrompt: string | null;
}): Promise<PersistedQueuedSetupTask[]> {
  const suggestionRows = await getPersistedTaskSuggestionRows(
    selectedSuggestionIds,
  );
  const suggestionIdsBySortOrder = new Set(suggestionRows.map(({ id }) => id));

  if (suggestionIdsBySortOrder.size !== selectedSuggestionIds.length) {
    throw new Error(
      'One or more selected suggestions are no longer available.',
    );
  }

  return db.transaction(async (tx) => {
    const existingRows = await getMutableQueuedSetupTasks(
      setupOnboardingTaskId,
      tx,
    );

    // Refuse to replace the queue while a launch is genuinely in flight or an
    // item already launched. A *stale* `launchClaimedAt` (older than the shared
    // stale-claim window) is left by a crash between claim and finalize; with
    // per-item stale-claim recovery now in place that row is recoverable, so it
    // must not block re-queuing forever. Only a launched row or a fresh claim
    // blocks replacement.
    const staleClaimThreshold = new Date(
      Date.now() - WORK_ITEM_LAUNCH_STALE_CLAIM_MS,
    );

    if (
      existingRows.some(
        (queuedTask) =>
          queuedTask.launchedAt !== null ||
          (queuedTask.launchClaimedAt !== null &&
            queuedTask.launchClaimedAt > staleClaimThreshold),
      )
    ) {
      return existingRows.map(stripMutableQueuedSetupTask);
    }

    await tx
      .delete(workItems)
      .where(
        and(
          eq(workItems.sourceTaskId, setupOnboardingTaskId),
          eq(workItems.kind, 'onboarding'),
        ),
      );

    const nextRows: Array<{
      kind: 'onboarding';
      sourceTaskId: string;
      selectedByUserId: string;
      sourceWorkItemId: string | null;
      title: string;
      executionPrompt: string;
      sortOrder: number;
    }> = suggestionRows.map((suggestion, index) => ({
      kind: 'onboarding',
      sourceTaskId: setupOnboardingTaskId,
      selectedByUserId,
      sourceWorkItemId: suggestion.id,
      title: suggestion.title,
      executionPrompt: suggestion.brief ?? '',
      sortOrder: index,
    }));

    if (customTaskPrompt) {
      nextRows.push({
        kind: 'onboarding',
        sourceTaskId: setupOnboardingTaskId,
        selectedByUserId,
        sourceWorkItemId: null,
        title: buildCustomQueuedTaskTitle(customTaskPrompt),
        executionPrompt: customTaskPrompt,
        sortOrder: nextRows.length,
      });
    }

    if (nextRows.length === 0) {
      return [];
    }

    return tx.insert(workItems).values(nextRows).returning({
      id: workItems.id,
      suggestionId: workItems.sourceWorkItemId,
      title: workItems.title,
      prompt: workItems.executionPrompt,
      sortOrder: workItems.sortOrder,
      launchedTaskId: workItems.launchedTaskId,
      launchedAt: workItems.launchedAt,
      environmentId: workItems.targetEnvironmentId,
    });
  });
}

type ClaimedQueuedSetupTask = {
  id: string;
  suggestionId: string | null;
  selectedByUserId: string | null;
  prompt: string | null;
  /** The `launchClaimedAt` fencing token for this claim. */
  claimedAt: Date;
};

/**
 * Claims the queued onboarding items for a setup task through the shared fenced
 * CAS, preserving the previous batch semantics: fetch the candidate onboarding
 * rows for the setup task in queue order, attempt to claim each, and return
 * whichever claims succeeded (each carrying its own fencing token).
 *
 * Migrated off the single batch UPDATE gated on `launchedAt IS NULL AND
 * launchClaimedAt IS NULL`, which had no stale-claim recovery: a crash between
 * claim and finalize left an item `launching` forever. `claimWorkItem` instead
 * claims `open` OR a stale `launching` row (older than the shared stale-claim
 * window) and guards `launched_task_id IS NULL`, so a crashed launch recovers,
 * a fresh in-flight claim on one item is skipped (only that item), and an
 * already-launched item is never re-claimed. Onboarding rows are inserted with
 * the `work_items.status` default of `open`, so the claim predicate matches the
 * rows produced by `replaceQueuedSetupTasks`. Each claim is its own atomic CAS,
 * so no wrapping transaction is needed.
 */
async function claimQueuedSetupTasksForLaunch(
  setupOnboardingTaskId: string,
): Promise<ClaimedQueuedSetupTask[]> {
  const candidates = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.sourceTaskId, setupOnboardingTaskId),
        eq(workItems.kind, 'onboarding'),
      ),
    )
    .orderBy(asc(workItems.sortOrder));

  const claimedTasks: ClaimedQueuedSetupTask[] = [];

  for (const candidate of candidates) {
    const claimed = await claimWorkItem(db, {
      id: candidate.id,
      extraConditions: [eq(workItems.kind, 'onboarding')],
    });

    if (!claimed) {
      continue;
    }

    claimedTasks.push({
      id: claimed.id,
      suggestionId: claimed.sourceWorkItemId,
      selectedByUserId: claimed.selectedByUserId,
      prompt: claimed.executionPrompt,
      claimedAt: claimed.launchClaimedAt,
    });
  }

  return claimedTasks;
}

// Exported for the DB-backed launch-lifecycle tests, which exercise the fenced
// claim/finalize/release flow directly. Not part of the tRPC command surface.
export async function launchQueuedSetupTasksIfReady({
  setupOnboardingTaskId,
  matchingEnvironmentId,
  slackTeamId,
  slackChannel,
  slackThreadTs,
  chatHandoffProvider,
  chatHandoffChannelId,
  chatHandoffThreadId,
  chatHandoffServiceUrl,
}: {
  setupOnboardingTaskId: string | null;
  matchingEnvironmentId: string | null;
  slackTeamId?: string | null;
  slackChannel?: string | null;
  slackThreadTs?: string | null;
  chatHandoffProvider?: string | null;
  chatHandoffChannelId?: string | null;
  chatHandoffThreadId?: string | null;
  chatHandoffServiceUrl?: string | null;
}) {
  if (!setupOnboardingTaskId || !matchingEnvironmentId) {
    return;
  }

  const claimedTasks = await claimQueuedSetupTasksForLaunch(
    setupOnboardingTaskId,
  );

  if (claimedTasks.length === 0) {
    return;
  }

  // Non-Slack kickoffs (Discord, Telegram, Teams) carry provider-neutral
  // communication metadata so the launched starter tasks reply into the same
  // chat that hosted the setup kickoff.
  const nonSlackChatHandoffProvider =
    chatHandoffProvider === 'discord' ||
    chatHandoffProvider === 'telegram' ||
    chatHandoffProvider === 'teams'
      ? chatHandoffProvider
      : null;
  const communicationMetadata =
    nonSlackChatHandoffProvider && chatHandoffChannelId
      ? {
          communicationProvider: nonSlackChatHandoffProvider,
          communicationChannelId: chatHandoffChannelId,
          ...(chatHandoffThreadId
            ? { communicationThreadId: chatHandoffThreadId }
            : {}),
          ...(chatHandoffServiceUrl
            ? { communicationServiceUrl: chatHandoffServiceUrl }
            : {}),
        }
      : {};

  const queuedSourceControlProvider =
    await resolveEnvironmentSourceControlProvider(matchingEnvironmentId);

  await Promise.allSettled(
    claimedTasks.map(async (queuedTask) => {
      let launchResult: Awaited<ReturnType<typeof enqueueTask>>;

      if (!queuedTask.selectedByUserId) {
        const failedAt = new Date();
        const launchError = 'Queued setup task has no selecting user.';

        await db
          .update(workItems)
          .set({
            status: 'failed',
            failedAt,
            launchError,
            launchClaimedAt: null,
            updatedAt: failedAt,
          })
          .where(
            and(
              eq(workItems.id, queuedTask.id),
              eq(workItems.kind, 'onboarding'),
              eq(workItems.status, 'launching'),
              eq(workItems.launchClaimedAt, queuedTask.claimedAt),
            ),
          );

        console.warn(
          `[setup-new] onboarding work item ${queuedTask.id} cannot launch: ${launchError}`,
        );
        return;
      }

      try {
        launchResult = await enqueueTask({
          task: {
            type: TaskPayloadKind.StandardTask,
            payload: {
              repo: '',
              environmentId: matchingEnvironmentId,
              ...(queuedSourceControlProvider
                ? { sourceControlProvider: queuedSourceControlProvider }
                : {}),
              ...(slackTeamId ? { teamId: slackTeamId } : {}),
              ...(slackChannel ? { slackChannel } : {}),
              ...(slackThreadTs ? { slackThreadTs } : {}),
              ...communicationMetadata,
              description: queuedTask.prompt ?? '',
            },
          },
          initiator: {
            kind: 'user',
            userId: queuedTask.selectedByUserId,
          },
          workflow: 'setup_onboarding',
          surface: 'web',
          trigger: 'manual',
          ...(slackChannel || slackThreadTs
            ? {
                channels: {
                  slackChannelId: slackChannel ?? null,
                  slackThreadTs: slackThreadTs ?? null,
                },
              }
            : {}),
        });
      } catch (error) {
        // The enqueue never succeeded, so no run exists: release our claim back
        // to `open` so a later trigger can retry promptly. The fenced release
        // never reverts a `launched` item and never reverts a claim already
        // reclaimed by another launcher. Only a pre-enqueue failure may release;
        // see the post-enqueue invariant below.
        await releaseWorkItemClaim(db, {
          id: queuedTask.id,
          claimedAt: queuedTask.claimedAt,
          extraConditions: [eq(workItems.kind, 'onboarding')],
        });

        console.warn(
          `[setup-new] enqueue failed for onboarding work item ${queuedTask.id}; released its claim back to open — ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
        return;
      }

      // Fenced finalize: `launching` -> `launched` only when our claim token
      // still matches, stamping `targetEnvironmentId` in the same guarded write.
      // Runs directly against `db` (not a transaction): it is a single fenced
      // UPDATE, and the suggestion mirror below deliberately no longer shares
      // its atomicity so a mirror failure can never roll back a healthy launch.
      //
      // Invariant: once the task is enqueued, a failure of unknown cause must
      // never release the claim. Releasing would let the next readiness pass
      // re-claim and launch a duplicate immediately, while leaving the claim in
      // place lets stale-claim recovery retry safely only after the shared
      // window. So a throw here is treated exactly like a lost finalize
      // (`finalized = false`), which drives the orphan-cancel branch. In the
      // rare ambiguous case where the finalize committed but its ack was lost,
      // the cancel may kill a healthy linked run; that trade is intentional — a
      // visibly canceled task beats a silent duplicate.
      let finalized: boolean;

      try {
        finalized = await finalizeWorkItemLaunched(db, {
          id: queuedTask.id,
          taskId: launchResult.taskId,
          claimedAt: queuedTask.claimedAt,
          targetEnvironmentId: matchingEnvironmentId,
        });
      } catch (error) {
        console.warn(
          `[setup-new] finalize threw for onboarding work item ${queuedTask.id} after enqueuing task ${launchResult.taskId} (run ${launchResult.id}); treating as a lost finalize and leaving the claim for stale-claim recovery — ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
        finalized = false;
      }

      if (!finalized) {
        // The task is already enqueued but the finalize did not commit (the
        // fencing guard rejected it, or it threw), so the run is orphaned from
        // this work item. Best-effort cancel it while it is still pre-sandbox,
        // and log loudly either way with the cancel outcome (matches the
        // implement.ts orphan handling). Return before the mirror: a lost or
        // failed finalize must never mirror a launch that did not link.
        let cancelNote = 'orphaned run left running';

        try {
          const canceled = await cancelTaskRunDirect({
            runId: launchResult.id,
            error:
              'Canceled: setup-new queued task launch finalize lost the claim fencing guard',
          });
          if (canceled) {
            void captureTaskSettled(launchResult.id, 'canceled');
          }
          cancelNote = canceled
            ? 'orphaned run canceled'
            : 'orphaned run cancel did not apply (already started or terminal)';
        } catch (cancelError) {
          cancelNote = `orphaned run cancel failed: ${
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError)
          }`;
        }

        console.warn(
          `[setup-new] finalize lost the fencing guard for onboarding work item ${queuedTask.id}; orphaned task ${launchResult.taskId} (run ${launchResult.id}) runs unlinked — ${cancelNote}.`,
        );
        return;
      }

      // Mirror the launched state onto the source suggestion only after a
      // committed finalize, outside any transaction and best-effort: the launch
      // link is already finalized and must stay finalized, so a mirror throw is
      // logged and swallowed rather than allowed to undo the launch.
      if (queuedTask.suggestionId) {
        try {
          await markSuggestionWorkItemLaunched({
            suggestionId: queuedTask.suggestionId,
            launchedTaskId: launchResult.taskId,
          });
        } catch (error) {
          console.warn(
            `[setup-new] failed to mirror launched state onto suggestion ${queuedTask.suggestionId} for task ${launchResult.taskId}; the onboarding launch stays finalized — ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
        }
      }
    }),
  );
}

async function getMatchingEnvironmentSummary({
  selectedRepositoryFullNames,
  onboardingTaskStartedAt,
}: {
  selectedRepositoryFullNames: string[];
  onboardingTaskStartedAt: string | null;
}) {
  if (
    selectedRepositoryFullNames.length === 0 ||
    onboardingTaskStartedAt === null
  ) {
    return null;
  }

  const environmentList = await db.query.environments.findMany({
    where: eq(environments.isEval, false),
    columns: {
      id: true,
      name: true,
      config: true,
      createdAt: true,
    },
  });

  const matchingEnvironment = findMatchingSetupNewEnvironment(
    environmentList,
    selectedRepositoryFullNames,
    onboardingTaskStartedAt,
  );

  if (matchingEnvironment) {
    return {
      id: matchingEnvironment.id,
      name: matchingEnvironment.name,
    };
  }

  return null;
}

export async function getSetupNewStatusCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const { userId } = auth;
  await purgeSavedDeploymentWorkerImage();

  const [
    baseStatus,
    slackAccessStatus,
    persistedRuntimeModelConfig,
    persistedRuntimeComputeConfig,
    envVarNames,
    nonSecretAuthEnvValues,
    nonSecretModelEnvValues,
    nonSecretComputeEnvValues,
    nonSecretSourceControlEnvValues,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
  ] = await Promise.all([
    getSetupBaseStatus(auth),
    getSetupSlackAccessStatus({ userId }),
    getPersistedRuntimeModelConfig(),
    getPersistedRuntimeComputeConfig(),
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([...NON_SECRET_AUTH_ENV_VAR_NAMES]),
    getPersistedEnvironmentVariableValues(
      SETUP_MODEL_PROVIDER_CATALOG.flatMap((provider) => [
        ...(provider.authKind === 'endpoint' && provider.envVarName
          ? [provider.envVarName]
          : []),
        ...getSetupModelProviderAdditionalEnvFields(provider)
          .filter((field) => !field.secret)
          .map((field) => field.envVarName),
      ]),
    ),
    getPersistedEnvironmentVariableValues([
      ...NON_SECRET_COMPUTE_ENV_VAR_NAMES,
    ]),
    getPersistedEnvironmentVariableValues([
      ...NON_SECRET_SOURCE_CONTROL_ENV_VAR_NAMES,
    ]),
    isChatGptSubscriptionConnected(),
    isGitHubCopilotSubscriptionConnected(),
    isXaiSubscriptionConnected(),
  ]);
  let setupNewState = normalizeSetupNewState(baseStatus.setupNewState);

  if (
    setupNewState.onboardingTaskId &&
    setupNewState.suggestionTaskId === null &&
    hasSetupChatHandoffDestination(setupNewState)
  ) {
    try {
      await triggerTaskSuggestionsCommand(auth);
      setupNewState = await getPersistedSetupNewState();
    } catch (error) {
      console.error(
        `[getSetupNewStatusCommand] Failed to trigger task suggestions: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const { selectedRepositories } = await resolveSelectedRepositories(
    setupNewState.selectedRepositoryIds,
  ).catch(() => ({
    normalizedRepositoryIds: setupNewState.selectedRepositoryIds,
    selectedRepositories: [] as SelectedRepositorySummary[],
  }));

  const selectedRepositoryFullNames = selectedRepositories.map(
    (repository) => repository.fullName,
  );

  const [onboardingTask, matchingEnvironment] = await Promise.all([
    getOnboardingTaskState(setupNewState.onboardingTaskId),
    getMatchingEnvironmentSummary({
      selectedRepositoryFullNames,
      onboardingTaskStartedAt: setupNewState.onboardingTaskStartedAt,
    }),
  ]);
  const onboardingTaskStatus = onboardingTask.status;
  const onboardingTaskPhase = onboardingTask.taskPhase;
  const onboardingTaskFirstAssistantOutputAt =
    onboardingTask.firstAssistantOutputAt;

  const onboardingSucceeded =
    isSetupNewOnboardingSuccessStatus(
      onboardingTaskStatus,
      onboardingTaskPhase,
    ) && matchingEnvironment !== null;
  const onboardingEndedWithoutEnvironment =
    isSetupNewOnboardingTerminalSuccessStatus(
      onboardingTaskStatus,
      onboardingTaskPhase,
    ) && matchingEnvironment === null;
  const onboardingFailed =
    (isSetupNewOnboardingFailureStatus(onboardingTaskStatus) ||
      onboardingEndedWithoutEnvironment) &&
    !onboardingSucceeded;

  await launchQueuedSetupTasksIfReady({
    setupOnboardingTaskId: setupNewState.onboardingTaskId,
    matchingEnvironmentId: onboardingSucceeded ? matchingEnvironment.id : null,
    slackTeamId: setupNewState.slackTeamId,
    slackChannel: setupNewState.slackChannel,
    slackThreadTs: setupNewState.slackThreadTs,
    chatHandoffProvider: setupNewState.chatHandoffProvider,
    chatHandoffChannelId: setupNewState.chatHandoffChannelId,
    chatHandoffThreadId: setupNewState.chatHandoffThreadId,
    chatHandoffServiceUrl: setupNewState.chatHandoffServiceUrl,
  });

  const queuedOnboardingTasks = await getPersistedQueuedSetupTasks(
    setupNewState.onboardingTaskId,
  );
  const authSetup = buildSetupAuthStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames: envVarNames,
    persistedEnvVarValues: nonSecretAuthEnvValues,
    selectedProvider: setupNewState.authProvider,
  });
  const modelSetup = buildSetupModelStatus({
    runtimeEnv: process.env,
    persistedModelConfig: persistedRuntimeModelConfig,
    persistedEnvVarNames: envVarNames,
    persistedEnvVarValues: nonSecretModelEnvValues,
    selectedProvider: setupNewState.modelProvider,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
  });
  const computeSetup = buildSetupComputeStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames: envVarNames,
    persistedEnvVarValues: nonSecretComputeEnvValues,
    persistedComputeConfig: persistedRuntimeComputeConfig,
    selectedProvider: setupNewState.computeProvider,
  });
  // Present stale in-flight provisioning runs as failed so the wizard
  // offers a retry instead of polling forever after a web-process restart.
  setupNewState = {
    ...setupNewState,
    e2bTemplateBuild: presentSetupNewComputeProvisioning(
      setupNewState.e2bTemplateBuild,
    ),
    daytonaSnapshotBuild: presentSetupNewComputeProvisioning(
      setupNewState.daytonaSnapshotBuild,
    ),
    blaxelImageBuild: presentSetupNewComputeProvisioning(
      setupNewState.blaxelImageBuild,
    ),
    azureDiskImageBuild: presentSetupNewComputeProvisioning(
      setupNewState.azureDiskImageBuild,
    ),
  };

  const sourceControlConnection = await getSourceControlConnectionSummary();
  const gitlabBaseUrl = await resolveDeploymentEnvVar('GITLAB_BASE_URL');
  const sourceControlSetup = buildSetupSourceControlStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames: envVarNames,
    persistedEnvVarValues: nonSecretSourceControlEnvValues,
    selectedProvider: setupNewState.sourceControlProvider,
    connectedProviders: sourceControlConnection.connectedProviders,
    repositoryCounts: sourceControlConnection.repositoryCounts,
    gitlabBaseUrl,
  });

  const status = {
    hasGitHub: baseStatus.hasGitHub,
    hasSlack: slackAccessStatus.hasSlackUserMapping,
    hasSlackInstallation: slackAccessStatus.hasSlackInstallation,
    hasLinear: baseStatus.hasLinear,
    setupCompletedAt: baseStatus.setupCompletedAt,
    setupNewState,
    selectedRepositories,
    onboardingTaskStatus,
    onboardingTaskPhase,
    onboardingTaskFirstAssistantOutputAt,
    onboardingSucceeded,
    onboardingFailed,
    matchingEnvironment,
    queuedOnboardingTasks,
    authSetup,
    modelSetup,
    computeSetup,
    sourceControlSetup,
  };

  if (baseStatus.setupCompletedAt === null) {
    await recordSetupFunnelMilestones(evaluateSetupFunnelMilestones(status));
  }

  return status;
}

export async function saveSetupNewModelConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupModelProviderId;
    apiKey?: string;
    additionalEnvValues?: Record<string, string>;
    connectionName?: string;
    modelId?: string;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  let providerId = input.provider;
  let additionalEnvValues = input.additionalEnvValues;
  const apiKey = input.apiKey;

  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const slug = normalizeOpenAiCompatibleConnectionSlug(input.connectionName);
    if (!slug) {
      throw new Error(
        'Enter a connection name for the OpenAI-compatible endpoint.',
      );
    }
    providerId = buildOpenAiCompatibleProviderId(slug) as SetupModelProviderId;
    const instance = buildOpenAiCompatibleProviderInstance(slug, {
      label: input.connectionName?.trim() || slug,
    });
    const remappedAdditional: Record<string, string> = {};
    if (instance.labelEnvVarName && input.connectionName?.trim()) {
      remappedAdditional[instance.labelEnvVarName] =
        input.connectionName.trim();
    }
    for (const [name, value] of Object.entries(
      input.additionalEnvValues ?? {},
    )) {
      if (name === 'OPENAI_COMPATIBLE_API_KEY') {
        remappedAdditional[instance.apiKeyEnvVarName] = value;
        continue;
      }
      remappedAdditional[name] = value;
    }
    additionalEnvValues = remappedAdditional;
  } else if (isOpenAiCompatibleProviderId(providerId)) {
    // Already named — keep as-is.
  }

  const provider = getSetupModelProvider(providerId);
  const isOauthProvider = provider.authKind === 'oauth';

  const [chatgptConnected, githubCopilotConnected, xaiSubscriptionConnected] =
    await Promise.all([
      isChatGptSubscriptionConnected(),
      isGitHubCopilotSubscriptionConnected(),
      isXaiSubscriptionConnected(),
    ]);
  const selectedOauthConnected =
    provider.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID
      ? chatgptConnected
      : provider.id === 'github-copilot'
        ? githubCopilotConnected
        : provider.id === XAI_SUBSCRIPTION_PROVIDER_ID
          ? xaiSubscriptionConnected
          : false;

  // OAuth providers are connected through their
  // device-code flow rather than an API key. The setup wizard's Continue
  // records the provider choice and default model only after the operator
  // has connected an account, so the env-vars step becomes satisfied without
  // a credential env var.
  if (isOauthProvider && !selectedOauthConnected) {
    throw new Error(
      `Connect your ${provider.label} account to continue, or pick a different provider.`,
    );
  }

  let selectedDynamicModel = input.modelId?.trim();

  // Discovery in the wizard uses the catalog id `openai-compatible/...`.
  // After naming the connection, remap model ids onto the named provider.
  if (
    selectedDynamicModel?.startsWith(`${OPENAI_COMPATIBLE_PROVIDER_ID}/`) &&
    provider.id !== OPENAI_COMPATIBLE_PROVIDER_ID &&
    isOpenAiCompatibleProviderId(provider.id)
  ) {
    selectedDynamicModel = `${provider.id}/${selectedDynamicModel.slice(
      OPENAI_COMPATIBLE_PROVIDER_ID.length + 1,
    )}`;
  }

  if (provider.dynamicModels && !selectedDynamicModel) {
    throw new Error(`Choose a discovered ${provider.label} model to continue.`);
  }

  const runtimeModelConfig = provider.dynamicModels
    ? {
        ...createEmptyDeploymentModelConfig(),
        roomoteModel: selectedDynamicModel!,
      }
    : buildRecommendedDeploymentModelConfig(provider);

  if (!isOauthProvider) {
    await validateSetupModelProviderCredentials({
      provider,
      apiKey,
      additionalEnvValues,
      action: 'continue',
      modelId: runtimeModelConfig.roomoteModel!,
    });
  }

  return db.transaction(async (tx) => {
    const [currentState, persistedEnvVarNames, persistedTaskModelSettings] =
      await Promise.all([
        getPersistedSetupNewState(tx),
        getPersistedEnvironmentVariableNames(tx),
        getPersistedRawTaskModelSettings(tx),
      ]);
    const persistedEnvVarNameSet = new Set(persistedEnvVarNames);

    if (!isOauthProvider) {
      const { values: credentialValues, clearedEnvVarNames } =
        collectSetupModelProviderCredentialValues({
          provider,
          apiKey,
          additionalEnvValues,
          isEnvVarSatisfied: (envVarName) =>
            persistedEnvVarNameSet.has(envVarName) ||
            isConfiguredEnvValue(process.env[envVarName]),
          action: 'continue',
        });

      if (credentialValues.length > 0) {
        await upsertDeploymentEnvironmentVariables(tx, {
          userId,
          values: credentialValues,
        });
      }

      // Optional fields submitted as blank clear their previously saved value
      // (deployment-level rows only, mirroring how they are stored).
      const clearedPersistedEnvVarNames = clearedEnvVarNames.filter((name) =>
        persistedEnvVarNameSet.has(name),
      );

      if (clearedPersistedEnvVarNames.length > 0) {
        await tx
          .delete(environmentVariables)
          .where(
            and(
              isNull(environmentVariables.userId),
              inArray(environmentVariables.name, clearedPersistedEnvVarNames),
            ),
          );
      }
    }

    const setupNewState = normalizeSetupNewState({
      ...currentState,
      modelProvider: provider.id,
      lastInteractedByUserId: userId,
    });
    // Mirror the models settings page: connecting a provider the deployment
    // has no models for yet auto-adds its recommended models so the first
    // launch offers a usable model list.
    const connectedProviderIds = new Set<string>([
      provider.id,
      ...collectConnectedTaskModelProviderIds({
        runtimeEnv: process.env,
        persistedEnvVarNames,
        chatgptConnected,
        githubCopilotConnected,
        xaiSubscriptionConnected,
      }),
    ]);
    const autoAdd = buildAutoAddedTaskModelSettings({
      provider,
      persistedTaskModelSettings,
      connectedProviderIds,
    });
    const dynamicModelSettings = provider.dynamicModels
      ? (() => {
          const model = buildTaskModelOption({
            id: selectedDynamicModel!,
            displayName: selectedDynamicModel!.split('/').at(-1)!,
          });
          const current = normalizeTaskModelSettings(
            persistedTaskModelSettings,
          );

          return normalizeTaskModelSettings({
            models: [
              ...(current.models ?? []).filter((item) => item.id !== model.id),
              model,
            ],
            allowedModelIds: [...current.allowedModelIds, model.id],
            defaultModelId: model.id,
            // Keep the catalog sync's baseline/deletion memory intact.
            catalogSyncedModelIds: current.catalogSyncedModelIds,
          });
        })()
      : null;

    await Promise.all([
      savePersistedSetupNewState(setupNewState, tx),
      savePersistedRuntimeModelConfig(runtimeModelConfig, tx),
      ...(dynamicModelSettings
        ? [savePersistedTaskModelSettings(dynamicModelSettings, tx)]
        : autoAdd
          ? [savePersistedTaskModelSettings(autoAdd.taskModelSettings, tx)]
          : []),
    ]);

    return {
      setupNewState,
      runtimeModelConfig,
    };
  });
}

export async function saveSetupNewComputeProviderChoiceCommand(
  auth: UserAuthSuccess,
  input: {
    provider: ComputeProvider;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;

  return db.transaction(async (tx) => {
    const [currentState, persistedRuntimeComputeConfig, persistedEnvVarNames] =
      await Promise.all([
        getPersistedSetupNewState(tx),
        getPersistedRuntimeComputeConfig(tx),
        getPersistedEnvironmentVariableNames(tx),
      ]);
    const computeSetup = buildSetupComputeStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedComputeConfig: persistedRuntimeComputeConfig,
      selectedProvider: input.provider,
    });
    const providerStatus = findAvailableSetupComputeProvider(
      computeSetup,
      input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected sandbox provider is unavailable.');
    }

    const hasCredentialFields = providerStatus.fields.some(
      isComputeCredentialField,
    );
    const runtimeComputeConfig = hasCredentialFields
      ? persistedRuntimeComputeConfig
      : normalizeDeploymentComputeConfig({
          ...persistedRuntimeComputeConfig,
          defaultProvider: input.provider,
        });

    // Providers with credentials are only recorded as the wizard choice here.
    // The runtime default commits when their config step is confirmed, so
    // merely browsing a hosted provider must not switch the deployment onto it.
    // Credentialless providers such as Local Docker have no config step to
    // confirm, so choosing them commits the runtime default immediately.
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      computeProvider: input.provider,
      lastInteractedByUserId: userId,
    });

    await Promise.all([
      savePersistedSetupNewState(setupNewState, tx),
      ...(hasCredentialFields
        ? []
        : [savePersistedRuntimeComputeConfig(runtimeComputeConfig, tx)]),
    ]);

    return {
      setupNewState,
      runtimeComputeConfig,
    };
  });
}

export async function saveSetupNewComputeConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: ComputeProvider;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  const provider = getSetupComputeProvider(input.provider);

  const { provisioningToStart, ...result } = await db.transaction(
    async (tx) => {
      // Resolved inside the transaction, kicked off only after it commits so
      // the detached build reads the credentials the save just persisted.
      let provisioningToStart: {
        provider: SetupProvisionableComputeProvider;
        imageRef: string;
        templateRef: string;
      } | null = null;

      const [
        currentState,
        persistedRuntimeComputeConfig,
        persistedEnvVarNames,
      ] = await Promise.all([
        getPersistedSetupNewState(tx),
        getPersistedRuntimeComputeConfig(tx),
        getPersistedEnvironmentVariableNames(tx),
      ]);

      // In-request DOCKER_WORKER_IMAGE is only used for this save/provisioning
      // pass. It is not persisted as sticky deployment state; process env and
      // RELEASE_VERSION derivation own runtime configuration.
      const submittedWorkerImage =
        input.values?.[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() || null;
      const effectiveWorkerImage =
        process.env[SHARED_WORKER_IMAGE_ENV_VAR]?.trim() ||
        submittedWorkerImage ||
        deriveWorkerImageFromReleaseVersion(process.env) ||
        undefined;

      const computeSetup = buildSetupComputeStatus({
        runtimeEnv: process.env,
        persistedEnvVarNames,
        persistedComputeConfig: persistedRuntimeComputeConfig,
        selectedProvider: input.provider,
      });
      const providerStatus = findAvailableSetupComputeProvider(
        computeSetup,
        input.provider,
      );

      if (!providerStatus) {
        throw new Error('Selected sandbox provider is unavailable.');
      }

      if (isSetupProvisionableComputeProvider(input.provider)) {
        await acquireComputeProvisioningLock(input.provider, tx);
      }

      await purgeSavedDeploymentWorkerImage(tx);

      // Derive MODAL_BASE_IMAGE_REF when not env-provided or already saved.
      // Form submissions are ignored (deployment-managed like E2B/Daytona
      // artifacts).
      const derivedInfraDefaults = new Map<string, string>();

      if (input.provider === 'modal') {
        const baseImageField = providerStatus.fields.find(
          (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
        );
        const derivedBaseImageRef = resolveDerivedModalBaseImageRef({
          ...process.env,
          DOCKER_WORKER_IMAGE: effectiveWorkerImage,
        });

        if (
          baseImageField &&
          !baseImageField.runtimeSatisfied &&
          !baseImageField.savedSatisfied &&
          derivedBaseImageRef
        ) {
          derivedInfraDefaults.set('MODAL_BASE_IMAGE_REF', derivedBaseImageRef);
        }
      }

      // Provisionable providers' base images (the E2B worker template,
      // Daytona worker snapshot, or Blaxel sandbox image) cannot be derived like the Modal base image
      // — they are artifacts inside the operator's provider account. Manual
      // form overrides are not accepted; process env or auto-provisioning
      // owns them. When a registry-qualified worker image exists, the save
      // records credentials, marks the run as pending, and the run executes
      // detached after commit.
      const setupProvisioningFieldNames = new Set<string>();

      if (isSetupProvisionableComputeProvider(input.provider)) {
        const provisionableProvider = input.provider;
        const artifactEnvVar = providerStatus.fields.find((field) =>
          isAutoProvisionedComputeArtifactField(field),
        )?.envVarName;

        if (!artifactEnvVar) {
          throw new Error(
            `${providerStatus.label} has no provisionable artifact field.`,
          );
        }
        const provisioning = await prepareComputeProvisioningStart({
          provider: provisionableProvider,
          providerStatus,
          existingState: getSetupNewComputeProvisioningState(
            currentState,
            provisionableProvider,
          ),
          // Process env, in-request override, or RELEASE_VERSION derivation.
          dockerWorkerImage: effectiveWorkerImage,
          runtimeEnv: process.env,
          markPending: (nextState) => {
            provisioningToStart = {
              provider: provisionableProvider,
              imageRef: nextState.imageRef,
              templateRef: nextState.templateRef ?? '',
            };
          },
        });

        if (provisioning.fieldPending) {
          if (!provisioning.provisionable) {
            throw new Error(
              `${providerStatus.label} needs a registry-qualified worker image (for example via DOCKER_WORKER_IMAGE) so Roomote can provision the worker base image automatically.`,
            );
          }

          setupProvisioningFieldNames.add(artifactEnvVar);
        }

        if (provisioning.start) {
          provisioningToStart = provisioning.start;
        }
      }

      // Credentials and operator-editable infrastructure are persisted as
      // encrypted deployment env vars. Managed artifacts are process-env /
      // derived / provisioning only.
      const valuesToSave: Array<{ name: string; value: string }> = [];
      const envVarsToClear: string[] = [];

      for (const field of providerStatus.fields) {
        if (field.runtimeSatisfied) {
          continue;
        }

        if (isAutoProvisionedComputeArtifactField(field)) {
          continue;
        }

        const submitted =
          field.envVarName === 'MODAL_BASE_IMAGE_REF'
            ? ''
            : (input.values?.[field.envVarName]?.trim() ?? '');
        const validationError = getComputeFieldValidationError(
          field,
          submitted,
        );
        if (validationError) {
          throw new Error(validationError);
        }
        const nextValue =
          submitted ||
          (isComputeInfrastructureField(field)
            ? (derivedInfraDefaults.get(field.envVarName) ?? '')
            : '');

        if (!nextValue) {
          if (
            field.secret !== true &&
            !isRequiredComputeField(field) &&
            field.savedSatisfied
          ) {
            envVarsToClear.push(field.envVarName);
          }
          continue;
        }

        valuesToSave.push({ name: field.envVarName, value: nextValue });
      }

      const hasMissingRequiredValue = providerStatus.fields.some((field) => {
        if (setupProvisioningFieldNames.has(field.envVarName)) {
          return false;
        }

        // Modal base image is not form-collected; only runtime / saved / derived
        // values count toward satisfaction (same as the save loop above).
        const submitted =
          field.envVarName === 'MODAL_BASE_IMAGE_REF'
            ? ''
            : (input.values?.[field.envVarName]?.trim() ?? '');
        const nextValue =
          submitted ||
          (isComputeInfrastructureField(field)
            ? (derivedInfraDefaults.get(field.envVarName) ?? '')
            : '');

        return (
          isRequiredComputeField(field) &&
          !field.runtimeSatisfied &&
          !field.savedSatisfied &&
          nextValue.length === 0
        );
      });

      if (hasMissingRequiredValue) {
        throw new Error(
          `Enter the required ${provider.label} configuration values to continue.`,
        );
      }

      if (valuesToSave.length > 0) {
        await upsertDeploymentEnvironmentVariables(tx, {
          userId,
          values: valuesToSave,
        });
      }

      if (envVarsToClear.length > 0) {
        await tx
          .delete(environmentVariables)
          .where(
            and(
              isNull(environmentVariables.userId),
              inArray(environmentVariables.name, envVarsToClear),
            ),
          );
      }

      const setupNewState = normalizeSetupNewState({
        ...currentState,
        computeProvider: input.provider,
        ...(provisioningToStart
          ? {
              [SETUP_COMPUTE_PROVISIONING_STATE_FIELDS[
                provisioningToStart.provider
              ]]: createPendingComputeProvisioning(provisioningToStart),
            }
          : {}),
        lastInteractedByUserId: userId,
      });
      const runtimeComputeConfig = normalizeDeploymentComputeConfig({
        defaultProvider: input.provider,
      });

      await Promise.all([
        savePersistedSetupNewState(setupNewState, tx),
        savePersistedRuntimeComputeConfig(runtimeComputeConfig, tx),
      ]);

      return {
        setupNewState,
        runtimeComputeConfig,
        provisioningToStart,
      };
    },
  );

  if (provisioningToStart) {
    void runComputeProvisioning({
      userId,
      ...provisioningToStart,
    });
  }

  return result;
}

export async function saveSetupNewAuthProviderChoiceCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupAuthProviderId;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  return saveSetupAuthProviderChoice({
    provider: input.provider,
    actorUserId: userId,
  });
}

async function saveSetupAuthProviderChoice(input: {
  provider: SetupAuthProviderId;
  actorUserId: string | null;
  requireBootstrapOpen?: boolean;
}) {
  if (input.requireBootstrapOpen) {
    await assertSetupBootstrapOpen();
  }

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      authProvider: input.provider,
      lastInteractedByUserId: input.actorUserId,
    });

    await savePersistedSetupNewState(setupNewState, tx);

    return {
      setupNewState,
    };
  });
}

export async function saveSetupNewAuthConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupAuthProviderId;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  return saveSetupAuthConfig({
    provider: input.provider,
    values: input.values,
    actorUserId: userId,
  });
}

async function saveSetupAuthConfig(input: {
  provider: SetupAuthProviderId;
  values?: Partial<Record<string, string>>;
  actorUserId: string | null;
  requireBootstrapOpen?: boolean;
}) {
  if (input.requireBootstrapOpen) {
    await assertSetupBootstrapOpen();
  }
  const provider = getSetupAuthProvider(input.provider);

  // Runs before the transaction: it talks to Microsoft, and onboarding must
  // not report a configured Teams bot for credentials that never authenticated.
  if (input.provider === 'microsoft') {
    await assertTeamsBotCredentialsAuthenticate(input.values);
  }

  const result = await db.transaction(async (tx) => {
    const [currentState, persistedEnvVarNames] = await Promise.all([
      getPersistedSetupNewState(tx),
      getPersistedEnvironmentVariableNames(tx),
    ]);
    const authSetup = buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      selectedProvider: input.provider,
    });
    const providerStatus = authSetup.providers.find(
      (candidate) => candidate.id === input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected auth provider is unavailable.');
    }

    const valuesToSave = providerStatus.fields.flatMap((field) => {
      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

      if (!nextValue) {
        return [];
      }

      return [
        {
          name: field.envVarName,
          value: nextValue,
        },
      ];
    });

    const hasConfiguredAuthEnvVar = (name: string) =>
      Boolean(process.env[name]?.trim()) ||
      persistedEnvVarNames.includes(name) ||
      Boolean(input.values?.[name]?.trim());

    const microsoftTeamsBotResolution =
      input.provider === 'microsoft'
        ? resolveTeamsBotCredentialEnvVarNames({
            hasConfiguredEnvVar: hasConfiguredAuthEnvVar,
          })
        : null;

    const hasMissingRequiredValue = providerStatus.fields.some((field) => {
      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

      if (
        field.required === false ||
        field.runtimeSatisfied ||
        field.savedSatisfied ||
        nextValue.length > 0
      ) {
        return false;
      }

      if (
        microsoftTeamsBotResolution?.source === 'microsoft_auth' &&
        microsoftTeamsBotResolution.fieldSourceEnvVarNames[
          field.envVarName as keyof typeof microsoftTeamsBotResolution.fieldSourceEnvVarNames
        ]
      ) {
        return false;
      }

      return true;
    });

    if (hasMissingRequiredValue) {
      throw new Error(
        `Enter the required ${provider.label} configuration values to continue.`,
      );
    }

    if (valuesToSave.length > 0) {
      await upsertDeploymentEnvironmentVariables(tx, {
        userId: input.actorUserId,
        values: valuesToSave,
      });
    }

    const setupNewState = normalizeSetupNewState({
      ...currentState,
      authProvider: input.provider,
      lastInteractedByUserId: input.actorUserId,
    });

    await savePersistedSetupNewState(setupNewState, tx);

    return {
      setupNewState,
    };
  });

  // After the commit, or the 30s runtime credential cache keeps serving the
  // pre-save tuple and the next status refresh reports the old credentials
  // instead of the ones that were just verified and stored.
  if (input.provider === 'microsoft') {
    invalidateTeamsBotRuntimeCredentialsCache();
    invalidateTeamsBotCredentialCheckCache();
  }

  return result;
}

export async function saveSetupNewSourceControlProviderChoiceCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SourceControlProvider;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      sourceControlProvider: input.provider,
      lastInteractedByUserId: userId,
    });

    await savePersistedSetupNewState(setupNewState, tx);

    return {
      setupNewState,
    };
  });
}

export async function saveSetupNewSourceControlConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SourceControlProvider;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;

  return saveSourceControlConfig({
    provider: input.provider,
    values: input.values,
    actorUserId: userId,
  });
}

async function saveSourceControlConfig(input: {
  provider: SourceControlProvider;
  values?: Partial<Record<string, string>>;
  actorUserId: string;
}) {
  // Provider-API validation happens before the transaction so the external
  // HTTP round-trip never holds a pooled DB connection open.
  await assertValidSourceControlConfigInput({
    ...input,
    allowIncompleteDelegated: true,
  });

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);

    await saveSourceControlConfigValues({
      executor: tx,
      actorUserId: input.actorUserId,
      provider: input.provider,
      values: input.values,
    });

    const setupNewState = normalizeSetupNewState({
      ...currentState,
      sourceControlProvider: input.provider,
      lastInteractedByUserId: input.actorUserId,
    });

    await savePersistedSetupNewState(setupNewState, tx);

    return {
      setupNewState,
    };
  });
}

/**
 * Resolves the setup token for bootstrap commands: the explicit input when
 * the client still has it (e.g. from the ?token= query param), otherwise the
 * invite cookie, which is the only place the token survives OAuth sign-in
 * round-trips.
 */
async function resolveSetupTokenInput(
  setupToken: string | undefined,
): Promise<string | undefined> {
  if (setupToken != null) {
    return setupToken;
  }

  return (await getRequestInviteToken()) ?? undefined;
}

export async function getSetupBootstrapStatusCommand(input?: {
  setupToken?: string;
}) {
  const bootstrapState = await getSetupBootstrapState();
  const setupTokenRequired = bootstrapState.setupOpen && isSetupTokenRequired();

  if (
    setupTokenRequired &&
    !isSetupTokenValid(await resolveSetupTokenInput(input?.setupToken))
  ) {
    return {
      setupOpen: bootstrapState.setupOpen,
      setupTokenRequired,
      setupTokenSatisfied: false,
      authSetup: null,
    };
  }

  const [setupNewState, persistedEnvVarNames, nonSecretAuthEnvValues] =
    await Promise.all([
      getPersistedSetupNewState(),
      getPersistedEnvironmentVariableNames(),
      getPersistedEnvironmentVariableValues([...NON_SECRET_AUTH_ENV_VAR_NAMES]),
    ]);

  return {
    setupOpen: bootstrapState.setupOpen,
    setupTokenRequired,
    setupTokenSatisfied: true,
    authSetup: buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
      persistedEnvVarValues: nonSecretAuthEnvValues,
      selectedProvider: setupNewState.authProvider,
    }),
  };
}

export async function trackSetupWelcomeSeenCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  await recordSetupFunnelMilestones([{ milestone: 'welcome' }]);
}

export async function trackSetupCommsStateCommand(
  auth: UserAuthSuccess,
  input: {
    provider: 'microsoft' | 'telegram' | 'discord';
  },
) {
  assertAdmin(auth);
  const candidates = [];

  if (input.provider === 'microsoft') {
    const status = await getTeamsIntegrationStatusCommand(auth);
    if (status.botConfigured && status.microsoftAuthConfigured) {
      candidates.push({
        milestone: 'comms_configured' as const,
        provider: input.provider,
      });
    }
    if (status.primaryConversationReady) {
      candidates.push({
        milestone: 'comms_authed' as const,
        provider: input.provider,
      });
    }
  } else {
    if (input.provider === 'telegram') {
      invalidateTelegramRuntimeCredentialsCache();
    }
    const status =
      input.provider === 'telegram'
        ? await getLinkedTelegramAccountCommand(auth)
        : await getLinkedDiscordAccountCommand(auth);
    if (status.configured) {
      candidates.push({
        milestone: 'comms_configured' as const,
        provider: input.provider,
      });
    }
    if (status.mapping) {
      candidates.push({
        milestone: 'comms_authed' as const,
        provider: input.provider,
      });
    }
  }

  await recordSetupFunnelMilestones(candidates);
}

export async function trackSetupBootstrapWelcomeSeenCommand(input?: {
  setupToken?: string;
}) {
  assertSetupTokenValid(await resolveSetupTokenInput(input?.setupToken));
  await recordSetupFunnelMilestones([{ milestone: 'welcome' }]);
}

export async function saveSetupBootstrapAuthProviderChoiceCommand(input: {
  provider: SetupAuthProviderId;
  setupToken?: string;
}) {
  assertSetupTokenValid(await resolveSetupTokenInput(input.setupToken));

  return saveSetupAuthProviderChoice({
    provider: input.provider,
    actorUserId: null,
    requireBootstrapOpen: true,
  });
}

export async function saveSetupBootstrapAuthConfigCommand(input: {
  provider: SetupAuthProviderId;
  values?: Partial<Record<string, string>>;
  setupToken?: string;
}) {
  assertSetupTokenValid(await resolveSetupTokenInput(input.setupToken));

  return saveSetupAuthConfig({
    provider: input.provider,
    values: input.values,
    actorUserId: null,
    requireBootstrapOpen: true,
  });
}

export async function createSetupBootstrapSlackAppFromManifestCommand(input: {
  configToken: string;
  setupToken?: string;
}) {
  assertSetupTokenValid(await resolveSetupTokenInput(input.setupToken));
  await assertSetupBootstrapOpen();

  return createSlackAppFromManifest({
    configToken: input.configToken,
    actorUserId: null,
  });
}

export async function setSetupRecommendationEnabledCommand(
  auth: UserAuthSuccess,
  input: { id: string; enabled: boolean },
) {
  assertAdmin(auth);
  const recommendation = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    const state = await getPersistedSetupNewState(tx);
    const batch = state.automationRecommendations;
    const recommendation = batch?.recommendations.find(
      (item) => item.id === input.id,
    );
    if (!batch || !recommendation)
      throw new Error('Recommendation was not found.');
    const candidate = AUTOMATION_RECOMMENDATION_CATALOG.find(
      (item) => item.id === recommendation.candidateId,
    );
    if (!candidate) throw new Error('Recommendation candidate was not found.');

    const automationId = await applySetupRecommendationInTx(
      tx,
      auth,
      recommendation,
      input.enabled,
      candidate,
    );

    const nextBatch = {
      ...batch,
      recommendations: batch.recommendations.map((item) =>
        item.id === input.id
          ? {
              ...item,
              enabled: input.enabled,
              applied: true,
              ...(automationId ? { automationId } : {}),
            }
          : item,
      ),
    };
    await savePersistedSetupNewState(
      normalizeSetupNewState({
        ...state,
        automationRecommendations: nextBatch,
      }),
      tx,
    );
    return nextBatch.recommendations.find((item) => item.id === input.id);
  });
  const candidate = recommendation
    ? AUTOMATION_RECOMMENDATION_CATALOG.find(
        (item) => item.id === recommendation.candidateId,
      )
    : null;
  if (recommendation?.enabled && candidate?.source === 'built_in') {
    void captureActivationAutomationChanged('enabled', candidate.automationKey);
  }
  return recommendation;
}

async function applySetupRecommendationInTx(
  tx: DatabaseOrTransaction,
  auth: UserAuthSuccess,
  recommendation: AutomationRecommendationBatch['recommendations'][number],
  enabled: boolean,
  candidate: (typeof AUTOMATION_RECOMMENDATION_CATALOG)[number],
): Promise<string | null> {
  if (candidate.source === 'built_in') {
    await upsertAutomation(tx, {
      key: candidate.automationKey,
      enabled,
      schedule: {
        mode: enabled ? candidate.defaultScheduleMode : 'off',
      },
    });
    return null;
  }

  const existing = recommendation.automationId
    ? await getCustomAutomationById(recommendation.automationId, tx)
    : null;
  const automation = existing
    ? await updateCustomAutomation(
        existing.id,
        {
          name: candidate.template.name,
          prompt: candidate.template.prompt,
          enabled,
          scheduleMode: candidate.template.scheduleMode,
          environmentId: ALL_REPOSITORIES,
          target: {},
        },
        tx,
      )
    : await createCustomAutomation(
        {
          name: candidate.template.name,
          prompt: candidate.template.prompt,
          enabled,
          scheduleMode: candidate.template.scheduleMode,
          environmentId: ALL_REPOSITORIES,
          target: {},
          createdByUserId: auth.userId,
        },
        tx,
      );
  return automation.id;
}

export async function applySetupRecommendationsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const batch = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    const state = await getPersistedSetupNewState(tx);
    const batch = state.automationRecommendations;
    if (!batch || batch.status !== 'ready') return batch;

    const recommendations = [];
    for (const recommendation of batch.recommendations) {
      const candidate = AUTOMATION_RECOMMENDATION_CATALOG.find(
        (item) => item.id === recommendation.candidateId,
      );
      if (!candidate) {
        throw new Error('Recommendation candidate was not found.');
      }
      const automationId = await applySetupRecommendationInTx(
        tx,
        auth,
        recommendation,
        recommendation.enabled,
        candidate,
      );
      recommendations.push({
        ...recommendation,
        applied: true,
        ...(automationId ? { automationId } : {}),
      });
    }

    const nextBatch = { ...batch, recommendations };
    nextBatch.applicationState = 'applied';
    await savePersistedSetupNewState(
      normalizeSetupNewState({
        ...state,
        automationRecommendations: nextBatch,
      }),
      tx,
    );
    return nextBatch;
  });
  for (const recommendation of batch?.recommendations ?? []) {
    if (!recommendation.enabled) continue;
    const candidate = AUTOMATION_RECOMMENDATION_CATALOG.find(
      (item) => item.id === recommendation.candidateId,
    );
    if (candidate?.source === 'built_in') {
      void captureActivationAutomationChanged(
        'enabled',
        candidate.automationKey,
      );
    }
  }
  await Promise.all(
    (batch?.recommendations ?? [])
      .filter((recommendation) => recommendation.enabled)
      .filter((recommendation) => {
        const candidate = AUTOMATION_RECOMMENDATION_CATALOG.find(
          (item) => item.id === recommendation.candidateId,
        );
        if (!candidate) return false;
        return !(
          candidate?.source === 'built_in' &&
          candidate.automationKey === 'review_code'
        );
      })
      .map(async (recommendation) => {
        try {
          await enqueueAutomationRecommendationInitialRun(
            {
              fingerprint: batch!.inputFingerprint,
              recommendationId: recommendation.id,
            },
            AUTOMATION_RECOMMENDATION_TRIGGER_DELAY_MS,
          );
        } catch (error) {
          console.error(
            `[applySetupRecommendationsCommand] Failed to schedule ${recommendation.id}:`,
            error,
          );
        }
      }),
  );
  return batch;
}

export async function skipSetupRecommendationsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    const state = await getPersistedSetupNewState(tx);
    const batch = state.automationRecommendations;
    if (!batch || (batch.applicationState ?? 'pending') !== 'pending') {
      return batch ?? null;
    }

    const nextBatch = {
      ...batch,
      applicationState: 'skipped' as const,
      recommendations: batch.recommendations.map((recommendation) => ({
        ...recommendation,
        enabled: false,
        applied: false,
      })),
    };
    await savePersistedSetupNewState(
      normalizeSetupNewState({
        ...state,
        automationRecommendations: nextBatch,
      }),
      tx,
    );
    return nextBatch;
  });
}

export async function listSetupRecommendationsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const state = await getPersistedSetupNewState();
  return state.automationRecommendations;
}

export async function startSetupRecommendationsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const {
    normalizedRepositoryIds: recommendationRepositoryIds,
    connectedRepositories,
  } = await resolveConnectedRecommendationRepositories();
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    const state = await getPersistedSetupNewState(tx);
    const fingerprint = buildAutomationRecommendationFingerprint(
      recommendationRepositoryIds,
      connectedRepositories[0]?.sourceControlProvider ?? null,
    );
    const existingBatch = state.automationRecommendations;
    const batch = {
      ...(existingBatch?.inputFingerprint === fingerprint
        ? existingBatch
        : {
            version: 1 as const,
            inputFingerprint: fingerprint,
            catalogVersion: AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
            completedAt: null,
            partial: false,
            dismissed: false,
            applicationState: 'pending' as const,
            recommendations: [],
          }),
      status: 'pending' as const,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorCode: null,
    };
    await savePersistedSetupNewState(
      normalizeSetupNewState({ ...state, automationRecommendations: batch }),
      tx,
    );
    return { batch, repositoryIds: recommendationRepositoryIds };
  });

  try {
    await enqueueAutomationRecommendations({
      fingerprint: result.batch.inputFingerprint,
      repositoryIds: result.repositoryIds,
    });
  } catch (error) {
    console.error(
      '[startSetupRecommendationsCommand] Failed to enqueue recommendation scoring:',
      error,
    );
    await db.transaction(async (tx) => {
      const state = await getPersistedSetupNewState(tx);
      if (
        state.automationRecommendations?.inputFingerprint !==
        result.batch.inputFingerprint
      ) {
        return;
      }
      await savePersistedSetupNewState(
        normalizeSetupNewState({
          ...state,
          automationRecommendations: {
            ...state.automationRecommendations,
            status: 'failed',
            completedAt: new Date().toISOString(),
            errorCode: 'recommendation_queue_unavailable',
          },
        }),
        tx,
      );
    });
  }

  return result.batch;
}

async function runSetupRecommendationNowForCandidate(
  auth: UserAuthSuccess,
  recommendation: AutomationRecommendationBatch['recommendations'][number],
  candidate: (typeof AUTOMATION_RECOMMENDATION_CATALOG)[number],
) {
  if (
    candidate.source === 'built_in' &&
    candidate.automationKey === 'review_code'
  ) {
    throw new Error('Review Code runs from pull-request events.');
  }

  let automationId = recommendation.automationId;
  if (!recommendation.enabled) {
    const updatedRecommendation = await setSetupRecommendationEnabledCommand(
      auth,
      {
        id: recommendation.id,
        enabled: true,
      },
    );
    automationId = updatedRecommendation?.automationId ?? null;
  }

  if (candidate.source === 'cookbook') {
    if (!automationId) {
      const refreshed = await listSetupRecommendationsCommand(auth);
      automationId =
        refreshed?.recommendations.find((item) => item.id === recommendation.id)
          ?.automationId ?? null;
    }
    if (!automationId)
      throw new Error('Recommendation automation was not created.');
    return triggerCustomAutomationCommand(auth, { id: automationId });
  }

  if (candidate.automationKey === 'review_code') {
    throw new Error('Review Code runs from pull-request events.');
  }

  return triggerAutomationCommand(auth, {
    automationKey: candidate.automationKey,
  });
}

async function recordSetupRecommendationLaunch(
  recommendationId: string,
  taskId: string,
) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    const state = await getPersistedSetupNewState(tx);
    const nextBatch = state.automationRecommendations
      ? {
          ...state.automationRecommendations,
          recommendations: state.automationRecommendations.recommendations.map(
            (item) =>
              item.id === recommendationId
                ? { ...item, enabled: true, lastRunTaskId: taskId }
                : item,
          ),
        }
      : null;
    if (nextBatch) {
      await savePersistedSetupNewState(
        normalizeSetupNewState({
          ...state,
          automationRecommendations: nextBatch,
        }),
        tx,
      );
    }
  });
}

export async function runSetupRecommendationNowCommand(
  auth: UserAuthSuccess,
  input: { id: string },
) {
  assertAdmin(auth);
  const batch = await listSetupRecommendationsCommand(auth);
  const recommendation = batch?.recommendations.find(
    (item) => item.id === input.id,
  );
  const candidate = recommendation
    ? AUTOMATION_RECOMMENDATION_CATALOG.find(
        (item) => item.id === recommendation.candidateId,
      )
    : null;
  if (!batch || !recommendation || !candidate) {
    throw new Error('Recommendation was not found.');
  }

  const result = await runSetupRecommendationNowForCandidate(
    auth,
    recommendation,
    candidate,
  );
  if (result.outcome === 'launched') {
    await recordSetupRecommendationLaunch(recommendation.id, result.taskId);
  }
  return result;
}

export async function dismissSetupRecommendationsCardCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    const state = await getPersistedSetupNewState(tx);
    if (!state.automationRecommendations) return null;
    const batch = { ...state.automationRecommendations, dismissed: true };
    await savePersistedSetupNewState(
      normalizeSetupNewState({ ...state, automationRecommendations: batch }),
      tx,
    );
    return batch;
  });
}

export async function saveSetupNewQueuedTasksCommand(
  auth: UserAuthSuccess,
  input: {
    selectedSuggestionIds: string[];
    customTaskPrompt?: string;
  },
) {
  assertAdmin(auth);
  const setupNewState = await getPersistedSetupNewState();

  if (!setupNewState.onboardingTaskId) {
    throw new Error('Start setup before queuing onboarding tasks.');
  }

  const customTaskPrompt = input.customTaskPrompt?.trim() || null;
  const selectedSuggestionIds = [...new Set(input.selectedSuggestionIds)];

  const { selectedRepositories } = await resolveSelectedRepositories(
    setupNewState.selectedRepositoryIds,
  ).catch(() => ({
    normalizedRepositoryIds: setupNewState.selectedRepositoryIds,
    selectedRepositories: [] as SelectedRepositorySummary[],
  }));

  const matchingEnvironment = await getMatchingEnvironmentSummary({
    selectedRepositoryFullNames: selectedRepositories.map(
      (repository) => repository.fullName,
    ),
    onboardingTaskStartedAt: setupNewState.onboardingTaskStartedAt,
  });
  const onboardingTask = await getOnboardingTaskState(
    setupNewState.onboardingTaskId,
  );
  const onboardingTaskStatus = onboardingTask.status;
  const onboardingTaskPhase = onboardingTask.taskPhase;
  const onboardingSucceeded =
    isSetupNewOnboardingSuccessStatus(
      onboardingTaskStatus,
      onboardingTaskPhase,
    ) && matchingEnvironment !== null;

  await replaceQueuedSetupTasks({
    setupOnboardingTaskId: setupNewState.onboardingTaskId,
    selectedByUserId: auth.userId,
    selectedSuggestionIds,
    customTaskPrompt,
  });

  await launchQueuedSetupTasksIfReady({
    setupOnboardingTaskId: setupNewState.onboardingTaskId,
    matchingEnvironmentId: onboardingSucceeded ? matchingEnvironment.id : null,
    slackTeamId: setupNewState.slackTeamId,
    slackChannel: setupNewState.slackChannel,
    slackThreadTs: setupNewState.slackThreadTs,
    chatHandoffProvider: setupNewState.chatHandoffProvider,
    chatHandoffChannelId: setupNewState.chatHandoffChannelId,
    chatHandoffThreadId: setupNewState.chatHandoffThreadId,
    chatHandoffServiceUrl: setupNewState.chatHandoffServiceUrl,
  });

  return {
    queuedOnboardingTasks: await getPersistedQueuedSetupTasks(
      setupNewState.onboardingTaskId,
    ),
  };
}

export async function ensureSetupNewDefaultAgentsCommand(
  auth: UserAuthSuccess,
) {
  return ensureDefaultSetupAgents(auth);
}

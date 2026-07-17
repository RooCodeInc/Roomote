import * as GitHub from '@roomote/github';
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  resolveEnvironmentSourceControlProvider,
  resolveSingleSourceControlProvider,
} from '@/lib/server/source-control-provider';
import { buildSetupKickoffText } from '@roomote/communication/chat-messages';
import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import type { TeamsCommunicationProvider } from '@roomote/communication/teams-provider';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { SlackNotifier } from '@roomote/slack';
import {
  db,
  deploymentSettings,
  environments,
  environmentVariables,
  taskRuns,
  workItems,
  slackInstallations,
  slackUserMappings,
  asc,
  eq,
  and,
  inArray,
  isNull,
  sql,
  cancelTaskRunDirect,
  claimWorkItem,
  finalizeWorkItemLaunched,
  releaseWorkItemClaim,
  WORK_ITEM_LAUNCH_STALE_CLAIM_MS,
  markTaskStartParallelCountEndedAt,
  resolveDeploymentEnvVar,
  purgeSavedDeploymentWorkerImage,
  resolveTelegramRuntimeCredentials,
  resolveDiscordRuntimeCredentials,
  syncSetupQualificationBlock,
  isChatGptSubscriptionConnected,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  createTeamsCommunicationProviderFromRuntimeCredentials,
  findTelegramPrimaryChatId,
  findDiscordDefaultDestination,
  findDiscordUserMappingByRoomoteUserId,
  findTeamsPrimaryConversation,
  recordSlackConversationMessageBestEffort,
} from '@roomote/sdk/server';
import {
  buildRecommendedDeploymentModelConfig,
  buildTaskModelOption,
  buildSetupAuthStatus,
  buildSetupComputeStatus,
  buildSetupModelStatus,
  buildSetupSourceControlStatus,
  collectSetupModelProviderCredentialValues,
  createEmptyDeploymentModelConfig,
  createEmptySetupNewState,
  RunStatus,
  TaskPayloadKind,
  resolveEvalHarnessSelection,
  type ComputeProvider,
  type DeploymentModelConfig,
  deriveWorkerImageFromReleaseVersion,
  getSetupAuthProvider,
  getSetupComputeProvider,
  getComputeFieldValidationError,
  getSetupModelProvider,
  getSetupModelProviderAdditionalEnvFields,
  SETUP_MODEL_PROVIDER_CATALOG,
  isAutoProvisionedComputeArtifactField,
  isComputeCredentialField,
  isComputeInfrastructureField,
  isConfiguredEnvValue,
  isExitedRunStatus,
  isRequiredComputeField,
  normalizeTaskModelSettings,
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
  type SetupComputeStatus,
  type SetupModelProviderId,
  type SetupProvisionableComputeProvider,
  type SourceControlProvider,
  type TaskModelSettings,
  WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import {
  assertSetupTokenValid,
  getLatestTaskRunsByTaskId,
  getRepositories,
  getRequestInviteToken,
  getSourceControlConnectionSummary,
  isSetupTokenRequired,
  isSetupTokenValid,
} from '@/lib/server';
import { areAllRepositoriesEmpty } from '@/lib/repositories';
import {
  appendEnvironmentDefinitionGuidance,
  buildSetupEnvironmentTaskTitle,
  buildSetupNewKickoffPrompt,
  buildSetupNewWorkspacePayload,
  findMatchingSetupNewEnvironment,
  isSetupNewOnboardingFailureStatus,
  isSetupNewOnboardingSuccessStatus,
  isSetupNewOnboardingTerminalSuccessStatus,
  normalizeRepositorySelection,
} from '@/lib/setup-new';
import type { QueuedOnboardingTask } from './types';

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
import { triggerTaskSuggestionsCommand } from '../task-suggestions';

type PersistedSetupNewState = ReturnType<typeof createEmptySetupNewState>;
type PersistedRuntimeModelConfig = DeploymentModelConfig;

type SelectedRepositorySummary = {
  id: string;
  fullName: string;
  sourceControlProvider: SourceControlProvider;
};

type PersistedQueuedSetupTask = QueuedOnboardingTask;

type MutableQueuedSetupTask = PersistedQueuedSetupTask & {
  launchClaimedAt: Date | null;
};

type ActiveSetupQualificationBlock = {
  reason: 'github_organization_required';
  email: string | null;
  emailDomain: string | null;
  githubAccountLogin: string | null;
  githubAccountType: string | null;
  lastBlockedAt: Date;
};

async function assertSetupBootstrapOpen() {
  const bootstrapState = await getSetupBootstrapState();

  if (!bootstrapState.setupOpen) {
    throw new Error('Initial setup is no longer open.');
  }
}

function getSetupQualificationBlockErrorMessage() {
  return 'Setup is currently limited to work email addresses. Use another work email or contact the team if this seems wrong.';
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
      throw new Error('Selected repositories are no longer available.');
    }

    selectedRepositories.push({
      id: repository.id,
      fullName: repository.fullName,
      sourceControlProvider: repository.sourceControlProvider,
    });
  }

  return {
    normalizedRepositoryIds: normalizeRepositorySelection(selectedRepositories),
    selectedRepositories: selectedRepositories.sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    ),
  };
}

async function assertHasCommittedRepositorySelection(repositoryIds: string[]) {
  const emptyStates = await GitHub.getRepositoryEmptyStates({
    repositoryIds,
  });

  if (
    emptyStates.size === repositoryIds.length &&
    areAllRepositoriesEmpty(
      [...emptyStates.values()].map((isEmpty) => ({ isEmpty })),
    )
  ) {
    throw new Error(
      emptyStates.size === 1
        ? 'The selected repository has no commits yet. Push an initial commit first, or choose a different repository.'
        : 'All selected repositories have no commits yet. Push an initial commit first, or choose different repositories.',
    );
  }
}

async function clearTaskSuggestions(
  sourceTaskId: string | null,
  executor: DatabaseOrTransaction = db,
) {
  if (!sourceTaskId) {
    return;
  }

  await executor
    .delete(workItems)
    .where(
      and(
        eq(workItems.sourceTaskId, sourceTaskId),
        eq(workItems.kind, 'suggestion'),
      ),
    );
}

async function clearQueuedSetupTasks(executor: DatabaseOrTransaction = db) {
  await executor.delete(workItems).where(eq(workItems.kind, 'onboarding'));
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

/**
 * Resolves the Slack DM target for the setup onboarding handoff. Returns null
 * when the deployment has no active Slack installation or the admin has no
 * linked Slack account, so setup can fall back to a web-only onboarding task.
 */
async function resolveSetupSlackHandoffTarget(
  input: {
    userId: string;
  },
  executor: DatabaseOrTransaction = db,
) {
  const installation = await getActiveSlackInstallation(executor);

  if (!installation) {
    return null;
  }

  const mapping = await getSlackUserMappingForTeam(
    {
      userId: input.userId,
      teamId: installation.teamId,
    },
    executor,
  );

  if (!mapping) {
    return null;
  }

  return {
    botAccessToken: installation.botAccessToken,
    slackTeamId: installation.teamId,
    slackUserId: mapping.slackUserId,
  };
}

type SetupChatFallbackHandoffTarget =
  | {
      provider: 'discord';
      channelId: string;
      guildId?: string;
      botToken: string;
      applicationId: string;
    }
  | { provider: 'telegram'; chatId: string; botToken: string }
  | {
      provider: 'teams';
      conversationId: string;
      serviceUrl: string;
      teams: TeamsCommunicationProvider;
    };

/**
 * Resolves the non-Slack chat destination for the setup onboarding kickoff,
 * matching the proactive-messaging fallback ordering (Slack > Discord >
 * Telegram > Teams). Returns null when no chat surface is available, so setup falls
 * back to a web-only onboarding task. Teams is only selected when both a
 * captured primary conversation and resolvable bot credentials exist, so a
 * half-configured Teams deployment never blocks onboarding.
 */
async function resolveSetupChatFallbackHandoffTarget(
  userId: string,
): Promise<SetupChatFallbackHandoffTarget | null> {
  const [discordCredentials, discordDestination, discordUserMapping] =
    await Promise.all([
      resolveDiscordRuntimeCredentials(),
      findDiscordDefaultDestination(),
      findDiscordUserMappingByRoomoteUserId(userId),
    ]);
  if (
    discordCredentials.botToken &&
    discordCredentials.applicationId &&
    discordUserMapping
  ) {
    try {
      const discord = new DiscordCommunicationProvider({
        botToken: discordCredentials.botToken,
        applicationId: discordCredentials.applicationId,
      });
      const directMessage = await discord.createDirectMessage(
        discordUserMapping.discordUserId,
      );
      return {
        provider: 'discord',
        channelId: directMessage.id,
        botToken: discordCredentials.botToken,
        applicationId: discordCredentials.applicationId,
      };
    } catch (error) {
      console.warn(
        '[setup-new] Failed to open a Discord DM with the linked setup user; trying another chat destination.',
        error,
      );
    }
  }
  if (
    discordCredentials.botToken &&
    discordCredentials.applicationId &&
    discordDestination
  ) {
    return {
      provider: 'discord',
      channelId: discordDestination.channelId,
      guildId: discordDestination.guildId,
      botToken: discordCredentials.botToken,
      applicationId: discordCredentials.applicationId,
    };
  }

  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (botToken) {
    const chatId = await findTelegramPrimaryChatId();

    if (chatId) {
      return { provider: 'telegram', chatId, botToken };
    }
  }

  const conversation = await findTeamsPrimaryConversation();

  if (conversation) {
    const teams =
      await createTeamsCommunicationProviderFromRuntimeCredentials();

    if (teams) {
      return {
        provider: 'teams',
        conversationId: conversation.conversationId,
        serviceUrl: conversation.serviceUrl,
        teams,
      };
    }

    console.warn(
      '[setup-new] Skipping the Teams setup kickoff because Teams bot credentials could not be resolved; onboarding continues as a web-only task.',
    );
  }

  return null;
}

function didSuggestionSourceChange({
  currentState,
  nextRepositoryIds,
  nextSetupGuidance,
}: {
  currentState: PersistedSetupNewState;
  nextRepositoryIds: string[];
  nextSetupGuidance: string | null;
}): boolean {
  return (
    currentState.setupGuidance !== nextSetupGuidance ||
    currentState.selectedRepositoryIds.length !== nextRepositoryIds.length ||
    currentState.selectedRepositoryIds.some(
      (repositoryId, index) => repositoryId !== nextRepositoryIds[index],
    )
  );
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

type SetupOnboardingComputeGate = {
  waiting: boolean;
  error: string | null;
};

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

async function getSetupOnboardingComputeGate(
  setupNewState: PersistedSetupNewState,
  executor: DatabaseOrTransaction,
): Promise<SetupOnboardingComputeGate> {
  const provider = setupNewState.computeProvider;

  if (!provider || !isSetupProvisionableComputeProvider(provider)) {
    return { waiting: false, error: null };
  }

  const persistedEnvVarNames =
    await getPersistedEnvironmentVariableNames(executor);
  const providerStatus = buildSetupComputeStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames,
    selectedProvider: provider,
  }).providers.find((candidate) => candidate.provider === provider);

  // A configured artifact means this is a non-blocking replacement. The old
  // artifact remains active while provisioning publishes its successor.
  if (providerStatus?.configSatisfied) {
    return { waiting: false, error: null };
  }

  const provisioning = presentSetupNewComputeProvisioning(
    getSetupNewComputeProvisioningState(setupNewState, provider),
  );
  const error =
    provisioning?.status === 'failed'
      ? `Sandbox provider provisioning failed: ${
          provisioning.error ?? 'The worker artifact could not be prepared.'
        } Retry provisioning in Settings → Sandboxes.`
      : null;

  return { waiting: true, error };
}

function enqueueSetupOnboardingTask(
  input: Parameters<typeof enqueueTask>[0],
  computeGate: SetupOnboardingComputeGate,
) {
  if (!computeGate.waiting) {
    return enqueueTask(input);
  }

  return enqueueTask(input, {
    enqueue: false,
    initialTaskPhase: WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE,
    initialError: computeGate.error,
  });
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

async function getActiveSetupQualificationBlock(
  auth: UserAuthSuccess,
): Promise<ActiveSetupQualificationBlock | null> {
  await Promise.all([
    syncSetupQualificationBlock({
      userId: auth.userId,
      reason: 'github_organization_required',
      blocked: false,
    }),
  ]);

  return null;
}

async function assertSetupQualificationNotBlocked(auth: UserAuthSuccess) {
  const activeSetupQualificationBlock =
    await getActiveSetupQualificationBlock(auth);

  if (!activeSetupQualificationBlock) {
    return;
  }

  throw new Error(getSetupQualificationBlockErrorMessage());
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
  ]);
  const activeSetupQualificationBlock =
    await getActiveSetupQualificationBlock(auth);
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

  return {
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
    setupQualification: {
      activeBlock: activeSetupQualificationBlock,
    },
  };
}

export async function saveSetupNewModelConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupModelProviderId;
    apiKey?: string;
    additionalEnvValues?: Record<string, string>;
    modelId?: string;
  },
) {
  assertAdmin(auth);

  const { userId } = auth;
  const provider = getSetupModelProvider(input.provider);
  const isOauthProvider = provider.authKind === 'oauth';

  const chatgptConnected = await isChatGptSubscriptionConnected();

  // OAuth providers (the ChatGPT subscription) are connected through the
  // device-code flow rather than an API key. The setup wizard's Continue
  // records the provider choice and default model only after the operator
  // has connected an account, so the env-vars step becomes satisfied without
  // a credential env var.
  if (isOauthProvider && !chatgptConnected) {
    throw new Error(
      `Connect your ${provider.label} account to continue, or pick a different provider.`,
    );
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
          apiKey: input.apiKey,
          additionalEnvValues: input.additionalEnvValues,
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
      modelProvider: input.provider,
      lastInteractedByUserId: userId,
    });
    // Connecting a provider applies its recommended per-role model defaults:
    // the provider's default coding model plus any recommended helper,
    // vision, code review, explore, and planning models.
    const selectedDynamicModel = input.modelId?.trim();

    if (provider.dynamicModels && !selectedDynamicModel) {
      throw new Error(
        `Choose a discovered ${provider.label} model to continue.`,
      );
    }

    const runtimeModelConfig = provider.dynamicModels
      ? {
          ...createEmptyDeploymentModelConfig(),
          roomoteModel: selectedDynamicModel!,
        }
      : buildRecommendedDeploymentModelConfig(provider);

    // Mirror the models settings page: connecting a provider the deployment
    // has no models for yet auto-adds its recommended models so the first
    // launch offers a usable model list.
    const connectedProviderIds = new Set<string>([
      provider.id,
      ...collectConnectedTaskModelProviderIds({
        runtimeEnv: process.env,
        persistedEnvVarNames,
        chatgptConnected,
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

  return db.transaction(async (tx) => {
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

export async function saveSetupNewSelectionCommand(
  auth: UserAuthSuccess,
  input: {
    repositoryIds: string[];
    setupGuidance?: string;
    selectedModelId?: string;
  },
) {
  assertAdmin(auth);
  await assertSetupQualificationNotBlocked(auth);

  const { userId } = auth;

  if (input.repositoryIds.length === 0) {
    throw new Error('Select at least one repository to continue.');
  }

  const { normalizedRepositoryIds } = await resolveSelectedRepositories(
    input.repositoryIds,
  );
  await assertHasCommittedRepositorySelection(normalizedRepositoryIds);
  const nextSetupGuidance = input.setupGuidance?.trim() || null;
  const nextSelectedModelId = input.selectedModelId?.trim() || null;

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      selectedRepositoryIds: normalizedRepositoryIds,
      setupGuidance: nextSetupGuidance,
      selectedModelId: nextSelectedModelId,
      onboardingTaskId: null,
      onboardingTaskStartedAt: null,
      slackTeamId: null,
      slackChannel: null,
      slackThreadTs: null,
      chatHandoffProvider: null,
      chatHandoffChannelId: null,
      chatHandoffThreadId: null,
      chatHandoffServiceUrl: null,
      suggestionTaskId: null,
      suggestionTaskStartedAt: null,
      suggestionGenerationTriggeredAt: null,
      lastInteractedByUserId: userId,
    });

    await savePersistedSetupNewState(setupNewState, tx);
    await clearQueuedSetupTasks(tx);

    if (
      didSuggestionSourceChange({
        currentState,
        nextRepositoryIds: normalizedRepositoryIds,
        nextSetupGuidance,
      })
    ) {
      await clearTaskSuggestions(currentState.suggestionTaskId, tx);
    }

    return {
      setupNewState,
    };
  });
}

export async function startSetupNewOnboardingTaskCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  await assertSetupQualificationNotBlocked(auth);

  const { userId } = auth;
  const startResult = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('setup-new'))`);

    const currentState = await getPersistedSetupNewState(tx);

    if (currentState.onboardingTaskId) {
      return {
        taskId: currentState.onboardingTaskId,
        startedAt: currentState.onboardingTaskStartedAt,
        launchedNewOnboardingTask: false as const,
      };
    }

    if (currentState.computeProvider) {
      const persistedRuntimeComputeConfig =
        await getPersistedRuntimeComputeConfig(tx);
      const computeSetup = buildSetupComputeStatus({
        runtimeEnv: process.env,
        persistedComputeConfig: persistedRuntimeComputeConfig,
        selectedProvider: currentState.computeProvider,
      });

      if (computeSetup.selectedProvider !== currentState.computeProvider) {
        throw new Error(
          'Selected sandbox provider is no longer available. Choose another provider before starting setup.',
        );
      }
    }

    const { normalizedRepositoryIds, selectedRepositories } =
      await resolveSelectedRepositories(currentState.selectedRepositoryIds);
    await assertHasCommittedRepositorySelection(normalizedRepositoryIds);

    if (selectedRepositories.length === 0) {
      throw new Error('Select at least one repository before starting setup.');
    }

    const selectedRepositoryFullNames = selectedRepositories.map(
      (repository) => repository.fullName,
    );
    const onboardingTaskTitle = buildSetupEnvironmentTaskTitle(
      selectedRepositoryFullNames,
    );
    const workspacePayload = buildSetupNewWorkspacePayload(
      selectedRepositoryFullNames,
    );
    // Stamp the provider explicitly: dequeue defaults to GitHub when the
    // payload omits it, which breaks non-GitHub deployments.
    const setupSourceControlProvider = resolveSingleSourceControlProvider(
      selectedRepositories.map(
        (repository) => repository.sourceControlProvider,
      ),
    );
    const prompt = appendEnvironmentDefinitionGuidance(
      buildSetupNewKickoffPrompt(selectedRepositoryFullNames),
      currentState.setupGuidance,
    );
    const modelSelection = resolveEvalHarnessSelection({
      model: currentState.selectedModelId ?? undefined,
    });

    if (!modelSelection.ok) {
      throw new Error(modelSelection.error);
    }

    const computeGate = await getSetupOnboardingComputeGate(currentState, tx);

    const handoffTarget = await resolveSetupSlackHandoffTarget(
      {
        userId,
      },
      tx,
    );

    if (!handoffTarget) {
      // No connected Slack workspace (or the admin never linked their Slack
      // account). Fall back to the next chat surface (Discord, Telegram, then Teams)
      // so the kickoff still gets a real conversation thread; only when no
      // chat surface exists does onboarding run as a web-only task whose
      // progress stays visible in the setup wizard's task panel.
      const fallbackTarget =
        await resolveSetupChatFallbackHandoffTarget(userId);

      if (fallbackTarget) {
        const kickoffMessage = buildSetupKickoffText();
        let kickoffMessageId: string | null = null;
        let kickoffChannelId: string | null = null;
        let kickoffThreadId: string | null = null;

        if (fallbackTarget.provider === 'discord') {
          const discord = new DiscordCommunicationProvider({
            botToken: fallbackTarget.botToken,
            applicationId: fallbackTarget.applicationId,
          });
          try {
            if (fallbackTarget.guildId) {
              const thread = await discord.createTaskThread({
                channelId: fallbackTarget.channelId,
                name: 'Set up Roomote',
                initialText: kickoffMessage,
              });
              if (thread.messageId) {
                kickoffMessageId = thread.messageId;
                kickoffChannelId = thread.parentChannelId;
                kickoffThreadId = thread.channelId;
              }
            } else {
              const posted = await discord.postMessage({
                channelId: fallbackTarget.channelId,
                text: kickoffMessage,
                textFormat: 'markdown',
              });
              kickoffMessageId = posted.messageId ?? null;
              kickoffChannelId = posted.messageId
                ? fallbackTarget.channelId
                : null;
            }
            if (!kickoffMessageId) {
              console.warn(
                '[setup-new] The Discord setup kickoff returned no message id; onboarding continues as a web-only task.',
              );
            }
          } catch (error) {
            console.warn(
              '[setup-new] Failed to create a Discord setup thread; onboarding continues as a web-only task.',
              error,
            );
          }
        } else if (fallbackTarget.provider === 'telegram') {
          const telegram = new TelegramCommunicationProvider({
            botToken: fallbackTarget.botToken,
          });
          try {
            const { hasTopicsEnabled } = await telegram.getBotInfo();
            if (hasTopicsEnabled) {
              const topic = await telegram.createForumTopic({
                channelId: fallbackTarget.chatId,
                name: 'Set up Roomote',
              });
              kickoffThreadId = topic.messageThreadId;
            }
          } catch (error) {
            console.warn(
              '[setup-new] Could not create a Telegram topic for the setup task; falling back to the primary chat.',
              error,
            );
          }
          const posted = await telegram.postMessage({
            channelId: fallbackTarget.chatId,
            ...(kickoffThreadId ? { threadId: kickoffThreadId } : {}),
            text: kickoffMessage,
            textFormat: 'markdown',
          });

          if (!posted.messageId) {
            throw new Error(
              'Roomote could not post the Telegram setup kickoff.',
            );
          }

          kickoffMessageId = posted.messageId;
          kickoffChannelId = fallbackTarget.chatId;
        } else {
          // Teams is best-effort: when the kickoff post fails, onboarding
          // continues as a web-only task instead of failing setup, and the
          // persisted handoff fields stay null so Teams never looks
          // connected without a delivered kickoff.
          try {
            const posted = await fallbackTarget.teams.postMessage({
              channelId: fallbackTarget.conversationId,
              serviceUrl: fallbackTarget.serviceUrl,
              text: kickoffMessage,
              textFormat: 'markdown',
            });

            if (posted.messageId) {
              kickoffMessageId = posted.messageId;
              kickoffChannelId = fallbackTarget.conversationId;
            } else {
              console.warn(
                '[setup-new] The Teams setup kickoff post returned no message id; onboarding continues as a web-only task.',
              );
            }
          } catch (error) {
            console.warn(
              '[setup-new] Failed to post the Teams setup kickoff; onboarding continues as a web-only task.',
              error,
            );
          }
        }

        if (kickoffMessageId && kickoffChannelId) {
          const startedAt = new Date().toISOString();
          const launchResult = await enqueueSetupOnboardingTask(
            {
              title: onboardingTaskTitle,
              task: {
                ...(modelSelection.harness
                  ? { harness: modelSelection.harness }
                  : {}),
                type: TaskPayloadKind.StandardTask,
                payload: {
                  ...workspacePayload,
                  ...(setupSourceControlProvider
                    ? { sourceControlProvider: setupSourceControlProvider }
                    : {}),
                  description: prompt,
                  visibleInTranscript: false,
                  communicationProvider: fallbackTarget.provider,
                  communicationChannelId: kickoffChannelId,
                  communicationMessageId: kickoffMessageId,
                  ...(kickoffThreadId
                    ? {
                        communicationThreadId: kickoffThreadId,
                        ...(fallbackTarget.provider === 'telegram'
                          ? { telegramTaskTopic: true }
                          : {}),
                        ...(fallbackTarget.provider === 'discord'
                          ? { discordTaskThread: true }
                          : {}),
                      }
                    : {}),
                  ...(fallbackTarget.provider === 'discord' &&
                  fallbackTarget.guildId
                    ? { communicationGuildId: fallbackTarget.guildId }
                    : {}),
                  ...(fallbackTarget.provider === 'teams'
                    ? {
                        communicationThreadId: kickoffMessageId,
                        communicationServiceUrl: fallbackTarget.serviceUrl,
                      }
                    : {}),
                  ...(modelSelection.harnessModelOverrides
                    ? {
                        harnessModelOverrides:
                          modelSelection.harnessModelOverrides,
                      }
                    : {}),
                },
              },
              initiator: { kind: 'user', userId },
              workflow: 'setup_onboarding',
              surface: 'web',
              trigger: 'manual',
            },
            computeGate,
          );

          await savePersistedSetupNewState(
            normalizeSetupNewState({
              ...currentState,
              selectedRepositoryIds: normalizedRepositoryIds,
              setupGuidance: currentState.setupGuidance ?? null,
              onboardingTaskId: launchResult.taskId,
              onboardingTaskStartedAt: startedAt,
              slackTeamId: null,
              slackChannel: null,
              slackThreadTs: null,
              chatHandoffProvider: fallbackTarget.provider,
              chatHandoffChannelId: kickoffChannelId,
              chatHandoffThreadId:
                kickoffThreadId ??
                (fallbackTarget.provider === 'teams' ? kickoffMessageId : null),
              chatHandoffServiceUrl:
                fallbackTarget.provider === 'teams'
                  ? fallbackTarget.serviceUrl
                  : null,
              lastInteractedByUserId: userId,
            }),
            tx,
          );

          return {
            taskId: launchResult.taskId,
            startedAt,
            launchedNewOnboardingTask: true as const,
          };
        }
      }

      const startedAt = new Date().toISOString();
      const launchResult = await enqueueSetupOnboardingTask(
        {
          title: onboardingTaskTitle,
          task: {
            ...(modelSelection.harness
              ? { harness: modelSelection.harness }
              : {}),
            type: TaskPayloadKind.StandardTask,
            payload: {
              ...workspacePayload,
              ...(setupSourceControlProvider
                ? { sourceControlProvider: setupSourceControlProvider }
                : {}),
              description: prompt,
              visibleInTranscript: false,
              ...(modelSelection.harnessModelOverrides
                ? {
                    harnessModelOverrides: modelSelection.harnessModelOverrides,
                  }
                : {}),
            },
          },
          initiator: { kind: 'user', userId },
          workflow: 'setup_onboarding',
          surface: 'web',
          trigger: 'manual',
        },
        computeGate,
      );

      await savePersistedSetupNewState(
        normalizeSetupNewState({
          ...currentState,
          selectedRepositoryIds: normalizedRepositoryIds,
          setupGuidance: currentState.setupGuidance ?? null,
          onboardingTaskId: launchResult.taskId,
          onboardingTaskStartedAt: startedAt,
          slackTeamId: null,
          slackChannel: null,
          slackThreadTs: null,
          chatHandoffProvider: null,
          chatHandoffChannelId: null,
          chatHandoffThreadId: null,
          chatHandoffServiceUrl: null,
          lastInteractedByUserId: userId,
        }),
        tx,
      );

      return {
        taskId: launchResult.taskId,
        startedAt,
        launchedNewOnboardingTask: true as const,
      };
    }

    const slack = new SlackNotifier(handoffTarget.botAccessToken);
    const slackChannel = await slack.openConversation(
      handoffTarget.slackUserId,
    );

    if (!slackChannel) {
      throw new Error('Roomote could not open a Slack DM for setup.');
    }

    const kickoffMessage = buildSetupKickoffText({
      userMention: `<@${handoffTarget.slackUserId}>`,
    });
    const slackThreadTs = await slack.postMessage({
      channel: slackChannel,
      text: kickoffMessage,
    });

    if (!slackThreadTs) {
      throw new Error('Roomote could not post the Slack setup kickoff.');
    }

    const startedAt = new Date().toISOString();
    let launchResult: Awaited<ReturnType<typeof enqueueTask>>;

    try {
      launchResult = await enqueueSetupOnboardingTask(
        {
          title: onboardingTaskTitle,
          task: {
            ...(modelSelection.harness
              ? { harness: modelSelection.harness }
              : {}),
            type: TaskPayloadKind.SlackAppMention,
            payload: {
              ...workspacePayload,
              ...(setupSourceControlProvider
                ? { sourceControlProvider: setupSourceControlProvider }
                : {}),
              channel: slackChannel,
              user: handoffTarget.slackUserId,
              text: prompt,
              ts: slackThreadTs,
              thread_ts: slackThreadTs,
              webPath: '/setup',
              visibleInTranscript: false,
              ...(modelSelection.harnessModelOverrides
                ? {
                    harnessModelOverrides: modelSelection.harnessModelOverrides,
                  }
                : {}),
            },
          },
          initiator: { kind: 'user', userId },
          workflow: 'setup_onboarding',
          surface: 'slack',
          trigger: 'manual',
          channels: {
            slackChannelId: slackChannel,
            slackThreadTs,
          },
        },
        computeGate,
      );
    } catch (error) {
      await slack.deleteMessage({ channel: slackChannel, ts: slackThreadTs });
      throw error;
    }

    await savePersistedSetupNewState(
      normalizeSetupNewState({
        ...currentState,
        selectedRepositoryIds: normalizedRepositoryIds,
        setupGuidance: currentState.setupGuidance ?? null,
        onboardingTaskId: launchResult.taskId,
        onboardingTaskStartedAt: startedAt,
        slackTeamId: handoffTarget.slackTeamId,
        slackChannel,
        slackThreadTs,
        chatHandoffProvider: 'slack',
        chatHandoffChannelId: slackChannel,
        chatHandoffThreadId: slackThreadTs,
        chatHandoffServiceUrl: null,
        lastInteractedByUserId: userId,
      }),
      tx,
    );

    await recordSlackConversationMessageBestEffort({
      logContext: 'setupNew.startOnboardingTask',
      subjectUserId: userId,
      slackTeamId: handoffTarget.slackTeamId,
      subjectSlackUserId: handoffTarget.slackUserId,
      slackChannelId: slackChannel,
      conversationKind: 'dm',
      messageTs: slackThreadTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: 'setup_dm',
      text: kickoffMessage,
      taskId: launchResult.taskId,
      runId: launchResult.id,
    });

    return {
      taskId: launchResult.taskId,
      startedAt,
      launchedNewOnboardingTask: true as const,
    };
  });

  try {
    await triggerTaskSuggestionsCommand(auth);
  } catch (error) {
    console.error(
      `[startSetupNewOnboardingTaskCommand] Failed to trigger task suggestions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    taskId: startResult.taskId,
    startedAt: startResult.startedAt,
  };
}

export async function cancelSetupNewOnboardingTaskCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);

  const currentState = await getPersistedSetupNewState();

  if (!currentState.onboardingTaskId) {
    return { success: true as const };
  }

  const jobs = await db
    .select({
      id: taskRuns.id,
      status: taskRuns.status,
    })
    .from(taskRuns)
    .where(eq(taskRuns.taskId, currentState.onboardingTaskId));

  const activeRunIds = jobs
    .filter((job) => !isExitedRunStatus(job.status))
    .map((job) => job.id);

  if (activeRunIds.length > 0) {
    const endedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(taskRuns)
        .set({
          status: RunStatus.Canceled,
          canceledAt: endedAt,
        })
        .where(inArray(taskRuns.id, activeRunIds));

      await Promise.all(
        activeRunIds.map((runId) =>
          markTaskStartParallelCountEndedAt(tx, {
            runId,
            endedAt,
          }),
        ),
      );
    });
  }

  return { success: true as const };
}

export async function resetSetupNewSelectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const { userId } = auth;

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      selectedRepositoryIds: [],
      setupGuidance: null,
      onboardingTaskId: null,
      onboardingTaskStartedAt: null,
      slackTeamId: null,
      slackChannel: null,
      slackThreadTs: null,
      chatHandoffProvider: null,
      chatHandoffChannelId: null,
      chatHandoffThreadId: null,
      chatHandoffServiceUrl: null,
      suggestionTaskId: null,
      suggestionTaskStartedAt: null,
      suggestionGenerationTriggeredAt: null,
      lastInteractedByUserId: userId,
    });

    await savePersistedSetupNewState(setupNewState, tx);
    await clearTaskSuggestions(currentState.suggestionTaskId, tx);
    await clearQueuedSetupTasks(tx);

    return {
      setupNewState,
    };
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
  await assertSetupQualificationNotBlocked(auth);

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

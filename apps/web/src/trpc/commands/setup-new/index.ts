import * as GitHub from '@roomote/github';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { buildSetupKickoffText } from '@roomote/communication/chat-messages';
import type { TeamsCommunicationProvider } from '@roomote/communication/teams-provider';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { SlackNotifier } from '@roomote/slack';
import {
  db,
  deploymentSettings,
  environments,
  environmentVariables,
  users,
  cloudJobs,
  taskSuggestions,
  setupNewQueuedTasks,
  slackInstallations,
  slackUserMappings,
  asc,
  eq,
  and,
  inArray,
  isNull,
  sql,
  markTaskStartParallelCountEndedAt,
  resolveDeploymentEnvVar,
  purgeSavedDeploymentWorkerImage,
  resolveTelegramRuntimeCredentials,
  syncSetupQualificationBlock,
  isChatGptSubscriptionConnected,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  createTeamsCommunicationProviderFromRuntimeCredentials,
  findTelegramPrimaryChatId,
  findTeamsPrimaryConversation,
  recordSlackConversationMessageBestEffort,
} from '@roomote/sdk/server';
import {
  buildSetupAuthStatus,
  buildSetupComputeStatus,
  buildSetupModelStatus,
  buildSetupSourceControlStatus,
  collectSetupModelProviderCredentialValues,
  createEmptySetupNewState,
  CloudTaskStatus,
  CloudTaskType,
  resolveEvalHarnessSelection,
  type ComputeProvider,
  type DeploymentModelConfig,
  deriveWorkerImageFromReleaseVersion,
  getSetupAuthProvider,
  getSetupComputeProvider,
  getSetupModelProvider,
  isComputeInfrastructureField,
  isConfiguredEnvValue,
  isExitedCloudTaskStatus,
  isRequiredComputeField,
  NON_SECRET_COMPUTE_ENV_VAR_NAMES,
  normalizeDeploymentComputeConfig,
  normalizeDeploymentModelConfig,
  getSetupNewComputeProvisioningState,
  hasSetupChatHandoffDestination,
  isSetupProvisionableComputeProvider,
  normalizeSetupNewState,
  presentSetupNewComputeProvisioning,
  resolveDerivedModalBaseImageRef,
  SETUP_COMPUTE_PROVISIONING_STATE_FIELDS,
  SHARED_WORKER_IMAGE_ENV_VAR,
  type SetupAuthProviderId,
  type SetupModelProviderId,
  type SetupProvisionableComputeProvider,
  type SourceControlProvider,
  type TaskModelSettings,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import {
  assertSetupTokenValid,
  getLatestCloudJobsByTaskId,
  getRepositories,
  getRequestInviteToken,
  getSourceControlConnectionSummary,
  isSetupTokenRequired,
  isSetupTokenValid,
} from '@/lib/server';
import { areAllRepositoriesEmpty } from '@/lib/repositories';
import {
  appendEnvironmentDefinitionGuidance,
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
  createPendingComputeProvisioning,
  prepareComputeProvisioningStart,
  runComputeProvisioning,
} from '../compute/compute-provisioning';
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

const SETUP_BOOTSTRAP_USER_ID = 'setup-bootstrap-user';

async function ensureSetupBootstrapAuditUser(
  executor: DatabaseOrTransaction,
): Promise<string> {
  const [existingUser] = await executor
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, SETUP_BOOTSTRAP_USER_ID))
    .limit(1);

  if (existingUser) {
    return existingUser.id;
  }

  await executor.insert(users).values({
    id: SETUP_BOOTSTRAP_USER_ID,
    name: 'Setup Bootstrap',
    email: 'setup-bootstrap@roomote.local',
    imageUrl: '',
    entity: {
      id: SETUP_BOOTSTRAP_USER_ID,
      name: 'Setup Bootstrap',
      email: 'setup-bootstrap@roomote.local',
      imageUrl: '',
    },
    metadata: {
      system: true,
    },
  });

  return SETUP_BOOTSTRAP_USER_ID;
}

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
    .delete(taskSuggestions)
    .where(eq(taskSuggestions.sourceTaskId, sourceTaskId));
}

async function clearQueuedSetupTasks(executor: DatabaseOrTransaction = db) {
  await executor.delete(setupNewQueuedTasks);
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
  | { provider: 'telegram'; chatId: string; botToken: string }
  | {
      provider: 'teams';
      conversationId: string;
      serviceUrl: string;
      teams: TeamsCommunicationProvider;
    };

/**
 * Resolves the non-Slack chat destination for the setup onboarding kickoff,
 * matching the proactive-messaging fallback ordering (Slack > Telegram >
 * Teams). Returns null when no chat surface is available, so setup falls
 * back to a web-only onboarding task. Teams is only selected when both a
 * captured primary conversation and resolvable bot credentials exist, so a
 * half-configured Teams deployment never blocks onboarding.
 */
async function resolveSetupChatFallbackHandoffTarget(): Promise<SetupChatFallbackHandoffTarget | null> {
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

  const latestCloudJobs = await getLatestCloudJobsByTaskId([taskId]);
  const latestJob = latestCloudJobs[taskId];

  return {
    status: latestJob?.status ?? null,
    taskPhase: latestJob?.taskPhase ?? null,
    firstAssistantOutputAt: latestJob?.firstAssistantOutputAt ?? null,
  };
}

async function getPersistedTaskSuggestionRows(suggestionIds?: string[]) {
  if (suggestionIds && suggestionIds.length === 0) {
    return [];
  }

  return db
    .select({
      id: taskSuggestions.id,
      title: taskSuggestions.title,
      brief: taskSuggestions.brief,
      sortOrder: taskSuggestions.sortOrder,
    })
    .from(taskSuggestions)
    .where(
      suggestionIds ? inArray(taskSuggestions.id, suggestionIds) : undefined,
    )
    .orderBy(asc(taskSuggestions.sortOrder));
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
      id: setupNewQueuedTasks.id,
      suggestionId: setupNewQueuedTasks.suggestionId,
      title: setupNewQueuedTasks.title,
      prompt: setupNewQueuedTasks.prompt,
      sortOrder: setupNewQueuedTasks.sortOrder,
      launchedTaskId: setupNewQueuedTasks.launchedTaskId,
      launchedAt: setupNewQueuedTasks.launchedAt,
      environmentId: setupNewQueuedTasks.environmentId,
    })
    .from(setupNewQueuedTasks)
    .where(eq(setupNewQueuedTasks.setupOnboardingTaskId, setupOnboardingTaskId))
    .orderBy(asc(setupNewQueuedTasks.sortOrder));
}

async function getMutableQueuedSetupTasks(
  setupOnboardingTaskId: string,
  executor: DatabaseOrTransaction = db,
): Promise<MutableQueuedSetupTask[]> {
  return executor
    .select({
      id: setupNewQueuedTasks.id,
      suggestionId: setupNewQueuedTasks.suggestionId,
      title: setupNewQueuedTasks.title,
      prompt: setupNewQueuedTasks.prompt,
      sortOrder: setupNewQueuedTasks.sortOrder,
      launchedTaskId: setupNewQueuedTasks.launchedTaskId,
      launchedAt: setupNewQueuedTasks.launchedAt,
      environmentId: setupNewQueuedTasks.environmentId,
      launchClaimedAt: setupNewQueuedTasks.launchClaimedAt,
    })
    .from(setupNewQueuedTasks)
    .where(eq(setupNewQueuedTasks.setupOnboardingTaskId, setupOnboardingTaskId))
    .orderBy(asc(setupNewQueuedTasks.sortOrder));
}

async function markTaskSuggestionStarted(
  input: {
    suggestionId: string;
    updatedAt: Date;
  },
  executor: DatabaseOrTransaction = db,
) {
  await executor
    .update(taskSuggestions)
    .set({
      status: 'started',
      updatedAt: input.updatedAt,
    })
    .where(eq(taskSuggestions.id, input.suggestionId));
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

    if (
      existingRows.some(
        (queuedTask) =>
          queuedTask.launchClaimedAt !== null || queuedTask.launchedAt !== null,
      )
    ) {
      return existingRows.map(stripMutableQueuedSetupTask);
    }

    await tx
      .delete(setupNewQueuedTasks)
      .where(
        eq(setupNewQueuedTasks.setupOnboardingTaskId, setupOnboardingTaskId),
      );

    const nextRows: Array<{
      setupOnboardingTaskId: string;
      selectedByUserId: string;
      suggestionId: string | null;
      title: string;
      prompt: string;
      sortOrder: number;
    }> = suggestionRows.map((suggestion, index) => ({
      setupOnboardingTaskId,
      selectedByUserId,
      suggestionId: suggestion.id,
      title: suggestion.title,
      prompt: suggestion.brief,
      sortOrder: index,
    }));

    if (customTaskPrompt) {
      nextRows.push({
        setupOnboardingTaskId,
        selectedByUserId,
        suggestionId: null,
        title: buildCustomQueuedTaskTitle(customTaskPrompt),
        prompt: customTaskPrompt,
        sortOrder: nextRows.length,
      });
    }

    if (nextRows.length === 0) {
      return [];
    }

    return tx.insert(setupNewQueuedTasks).values(nextRows).returning({
      id: setupNewQueuedTasks.id,
      suggestionId: setupNewQueuedTasks.suggestionId,
      title: setupNewQueuedTasks.title,
      prompt: setupNewQueuedTasks.prompt,
      sortOrder: setupNewQueuedTasks.sortOrder,
      launchedTaskId: setupNewQueuedTasks.launchedTaskId,
      launchedAt: setupNewQueuedTasks.launchedAt,
      environmentId: setupNewQueuedTasks.environmentId,
    });
  });
}

async function claimQueuedSetupTasksForLaunch(setupOnboardingTaskId: string) {
  return db.transaction(async (tx) => {
    const claimedAt = new Date();

    return tx
      .update(setupNewQueuedTasks)
      .set({
        launchClaimedAt: claimedAt,
        updatedAt: claimedAt,
      })
      .where(
        and(
          eq(setupNewQueuedTasks.setupOnboardingTaskId, setupOnboardingTaskId),
          isNull(setupNewQueuedTasks.launchedAt),
          isNull(setupNewQueuedTasks.launchClaimedAt),
        ),
      )
      .returning({
        id: setupNewQueuedTasks.id,
        suggestionId: setupNewQueuedTasks.suggestionId,
        selectedByUserId: setupNewQueuedTasks.selectedByUserId,
        prompt: setupNewQueuedTasks.prompt,
      });
  });
}

async function launchQueuedSetupTasksIfReady({
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

  // Non-Slack kickoffs (Telegram, Teams) carry provider-neutral
  // communication metadata so the launched starter tasks reply into the same
  // chat that hosted the setup kickoff.
  const nonSlackChatHandoffProvider =
    chatHandoffProvider === 'telegram' || chatHandoffProvider === 'teams'
      ? chatHandoffProvider
      : null;
  const communicationMetadata =
    nonSlackChatHandoffProvider && chatHandoffChannelId
      ? {
          communicationProvider: nonSlackChatHandoffProvider,
          communicationChannelId: chatHandoffChannelId,
          // Telegram treats communicationThreadId as a forum-topic
          // message_thread_id, which the private primary chat does not have,
          // so only Teams threads starter-task replies under the kickoff
          // message.
          ...(nonSlackChatHandoffProvider === 'teams' && chatHandoffThreadId
            ? { communicationThreadId: chatHandoffThreadId }
            : {}),
          ...(chatHandoffServiceUrl
            ? { communicationServiceUrl: chatHandoffServiceUrl }
            : {}),
        }
      : {};

  await Promise.allSettled(
    claimedTasks.map(async (queuedTask) => {
      try {
        const launchResult = await enqueueCloudTask(
          {
            userId: queuedTask.selectedByUserId,
            type: CloudTaskType.StandardTask,
            payload: {
              repo: '',
              environmentId: matchingEnvironmentId,
              ...(slackTeamId ? { teamId: slackTeamId } : {}),
              ...(slackChannel ? { slackChannel } : {}),
              ...(slackThreadTs ? { slackThreadTs } : {}),
              ...communicationMetadata,
              description: queuedTask.prompt,
            },
          },
          {
            launchClass: 'human',
          },
        );

        const launchedAt = new Date();

        await db.transaction(async (tx) => {
          await tx
            .update(setupNewQueuedTasks)
            .set({
              environmentId: matchingEnvironmentId,
              launchedTaskId: launchResult.taskId,
              launchedAt,
              updatedAt: launchedAt,
            })
            .where(eq(setupNewQueuedTasks.id, queuedTask.id));

          if (queuedTask.suggestionId) {
            await markTaskSuggestionStarted(
              {
                suggestionId: queuedTask.suggestionId,
                updatedAt: launchedAt,
              },
              tx,
            );
          }
        });
      } catch {
        await db
          .update(setupNewQueuedTasks)
          .set({
            launchClaimedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(setupNewQueuedTasks.id, queuedTask.id));
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
    nonSecretComputeEnvValues,
    chatgptConnected,
  ] = await Promise.all([
    getSetupBaseStatus(auth),
    getSetupSlackAccessStatus({ userId }),
    getPersistedRuntimeModelConfig(),
    getPersistedRuntimeComputeConfig(),
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([
      ...NON_SECRET_COMPUTE_ENV_VAR_NAMES,
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
    selectedProvider: setupNewState.authProvider,
  });
  const modelSetup = buildSetupModelStatus({
    runtimeEnv: process.env,
    persistedModelConfig: persistedRuntimeModelConfig,
    persistedEnvVarNames: envVarNames,
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
  };

  const sourceControlConnection = await getSourceControlConnectionSummary();
  const gitlabBaseUrl = await resolveDeploymentEnvVar('GITLAB_BASE_URL');
  const sourceControlSetup = buildSetupSourceControlStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames: envVarNames,
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
    const runtimeModelConfig = normalizeDeploymentModelConfig({
      roomoteModel: provider.defaultRoomoteModel,
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
      }),
    ]);
    const autoAdd = buildAutoAddedTaskModelSettings({
      provider,
      persistedTaskModelSettings,
      connectedProviderIds,
    });

    await Promise.all([
      savePersistedSetupNewState(setupNewState, tx),
      savePersistedRuntimeModelConfig(runtimeModelConfig, tx),
      ...(autoAdd
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
    const providerStatus = computeSetup.providers.find(
      (candidate) => candidate.provider === input.provider,
    );

    if (!providerStatus) {
      throw new Error('Selected sandbox provider is unavailable.');
    }

    const hasCredentialFields = providerStatus.fields.length > 0;
    const runtimeComputeConfig = hasCredentialFields
      ? persistedRuntimeComputeConfig
      : normalizeDeploymentComputeConfig({
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

      await purgeSavedDeploymentWorkerImage(tx);

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
      const providerStatus = computeSetup.providers.find(
        (candidate) => candidate.provider === input.provider,
      );

      if (!providerStatus) {
        throw new Error('Selected sandbox provider is unavailable.');
      }

      // When the Modal base image is not entered, not env-provided, and not
      // already saved, derive it from the effective worker image and persist
      // it. The published worker image doubles as the Modal base image.
      const derivedInfraDefaults = new Map<string, string>();

      if (input.provider === 'modal') {
        const baseImageField = providerStatus.fields.find(
          (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
        );
        const submittedBaseImage = input.values?.MODAL_BASE_IMAGE_REF?.trim();
        const derivedBaseImageRef = resolveDerivedModalBaseImageRef({
          ...process.env,
          DOCKER_WORKER_IMAGE: effectiveWorkerImage,
        });

        if (
          baseImageField &&
          !baseImageField.runtimeSatisfied &&
          !baseImageField.savedSatisfied &&
          !submittedBaseImage &&
          derivedBaseImageRef
        ) {
          derivedInfraDefaults.set('MODAL_BASE_IMAGE_REF', derivedBaseImageRef);
        }
      }

      // Provisionable providers' base images (the E2B worker template, the
      // Daytona worker snapshot) cannot be derived like the Modal base image
      // — they are artifacts inside the operator's provider account. When the
      // operator entered a manual artifact value, it is persisted directly and
      // no provisioning runs. Otherwise, when a registry-qualified worker
      // image exists, the save records the credentials, marks the run as
      // pending, and the run executes detached after commit.
      const setupProvisioningFieldNames = new Set<string>();

      if (isSetupProvisionableComputeProvider(input.provider)) {
        const provisionableProvider = input.provider;
        const artifactEnvVar =
          provisionableProvider === 'e2b'
            ? 'E2B_TEMPLATE_ID'
            : 'DAYTONA_SNAPSHOT_NAME';
        const manualArtifact = input.values?.[artifactEnvVar]?.trim();

        if (!manualArtifact) {
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
                `${providerStatus.label} needs a worker base image. Add a hosted worker image, or enter the ${artifactEnvVar} manually.`,
              );
            }

            setupProvisioningFieldNames.add(artifactEnvVar);
          }

          if (provisioning.start) {
            provisioningToStart = provisioning.start;
          }
        }
      }

      // Credentials and submitted/derived infrastructure values are persisted
      // as encrypted deployment env vars. DOCKER_WORKER_IMAGE is never sticky-
      // saved — runtime is process-env / release-derived only.
      const valuesToSave: Array<{ name: string; value: string }> = [];
      const envVarsToClear: string[] = [];

      for (const field of providerStatus.fields) {
        if (field.runtimeSatisfied) {
          continue;
        }

        const submitted = input.values?.[field.envVarName]?.trim() ?? '';
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

        const submitted = input.values?.[field.envVarName]?.trim() ?? '';
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

    const hasMissingRequiredValue = providerStatus.fields.some((field) => {
      const nextValue = input.values?.[field.envVarName]?.trim() ?? '';

      return (
        field.required !== false &&
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
      const auditUserId =
        input.actorUserId ?? (await ensureSetupBootstrapAuditUser(tx));

      await upsertDeploymentEnvironmentVariables(tx, {
        userId: auditUserId,
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
  await assertValidSourceControlConfigInput(input);

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

  const [setupNewState, persistedEnvVarNames] = await Promise.all([
    getPersistedSetupNewState(),
    getPersistedEnvironmentVariableNames(),
  ]);

  return {
    setupOpen: bootstrapState.setupOpen,
    setupTokenRequired,
    setupTokenSatisfied: true,
    authSetup: buildSetupAuthStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames,
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

    const { normalizedRepositoryIds, selectedRepositories } =
      await resolveSelectedRepositories(currentState.selectedRepositoryIds);
    await assertHasCommittedRepositorySelection(normalizedRepositoryIds);

    if (selectedRepositories.length === 0) {
      throw new Error('Select at least one repository before starting setup.');
    }

    const selectedRepositoryFullNames = selectedRepositories.map(
      (repository) => repository.fullName,
    );
    const workspacePayload = buildSetupNewWorkspacePayload(
      selectedRepositoryFullNames,
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

    const handoffTarget = await resolveSetupSlackHandoffTarget(
      {
        userId,
      },
      tx,
    );

    if (!handoffTarget) {
      // No connected Slack workspace (or the admin never linked their Slack
      // account). Fall back to the next chat surface (Telegram, then Teams)
      // so the kickoff still gets a real conversation thread; only when no
      // chat surface exists does onboarding run as a web-only task whose
      // progress stays visible in the setup wizard's task panel.
      const fallbackTarget = await resolveSetupChatFallbackHandoffTarget();

      if (fallbackTarget) {
        const kickoffMessage = buildSetupKickoffText();
        let kickoffMessageId: string | null = null;
        let kickoffChannelId: string | null = null;

        if (fallbackTarget.provider === 'telegram') {
          const telegram = new TelegramCommunicationProvider({
            botToken: fallbackTarget.botToken,
          });
          const posted = await telegram.postMessage({
            channelId: fallbackTarget.chatId,
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
          const launchResult = await enqueueCloudTask(
            {
              userId,
              ...(modelSelection.harness
                ? { harness: modelSelection.harness }
                : {}),
              attributionOverride: {
                kind: 'automatic',
                sourceKind: 'automation',
              },
              type: CloudTaskType.StandardTask,
              payload: {
                ...workspacePayload,
                description: prompt,
                visibleInTranscript: false,
                communicationProvider: fallbackTarget.provider,
                communicationChannelId: kickoffChannelId,
                communicationMessageId: kickoffMessageId,
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
            {
              launchClass: 'human',
            },
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
              chatHandoffThreadId: kickoffMessageId,
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
      const launchResult = await enqueueCloudTask(
        {
          userId,
          ...(modelSelection.harness
            ? { harness: modelSelection.harness }
            : {}),
          type: CloudTaskType.StandardTask,
          payload: {
            ...workspacePayload,
            description: prompt,
            visibleInTranscript: false,
            ...(modelSelection.harnessModelOverrides
              ? {
                  harnessModelOverrides: modelSelection.harnessModelOverrides,
                }
              : {}),
          },
        },
        {
          launchClass: 'human',
        },
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
    let launchResult: Awaited<ReturnType<typeof enqueueCloudTask>>;

    try {
      launchResult = await enqueueCloudTask(
        {
          userId,
          ...(modelSelection.harness
            ? { harness: modelSelection.harness }
            : {}),
          attributionOverride: {
            kind: 'automatic',
            sourceKind: 'automation',
          },
          type: CloudTaskType.SlackAppMention,
          payload: {
            ...workspacePayload,
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
        {
          launchClass: 'human',
        },
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
      cloudJobId: launchResult.id,
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
      id: cloudJobs.id,
      status: cloudJobs.status,
    })
    .from(cloudJobs)
    .where(eq(cloudJobs.taskId, currentState.onboardingTaskId));

  const activeJobIds = jobs
    .filter((job) => !isExitedCloudTaskStatus(job.status))
    .map((job) => job.id);

  if (activeJobIds.length > 0) {
    const endedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(cloudJobs)
        .set({
          status: CloudTaskStatus.Canceled,
          canceledAt: endedAt,
        })
        .where(inArray(cloudJobs.id, activeJobIds));

      await Promise.all(
        activeJobIds.map((cloudJobId) =>
          markTaskStartParallelCountEndedAt(tx, {
            cloudJobId,
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

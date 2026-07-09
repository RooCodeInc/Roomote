import {
  buildSuggestedTasksPrompt,
  enqueueCloudTask,
  findEnvironmentForRepo,
} from '@roomote/cloud-agents/server';
import {
  asc,
  db,
  deploymentSettings,
  eq,
  getBackgroundAgentSettingsForDeployment,
  resolveRepositorySelectionByIds,
  taskSuggestions,
} from '@roomote/db/server';
import {
  CloudTaskStatus,
  TaskPayloadKind,
  buildEnvironmentDefinitionWorkspacePayload,
  createEmptySetupNewState,
  isExitedCloudTaskStatus,
  normalizeSetupNewState,
} from '@roomote/types';

import { getLatestCloudJobsByTaskId } from '@/lib/server';
import type { UserAuthSuccess } from '@/types';
import { assertAdmin } from '../setup/shared';
import { decorateSuggestionsWithEnvironmentIds } from './launch-resolution';
import type {
  PersistedTaskSuggestion,
  TaskSuggestionGenerationStatus,
} from './types';

async function buildRepositoryCoverage(repositoryFullNames: string[]): Promise<
  Array<{
    repositoryFullName: string;
    targetEnvironmentId?: string;
  }>
> {
  return Promise.all(
    repositoryFullNames.map(async (repositoryFullName) => {
      const targetEnvironmentId =
        (await findEnvironmentForRepo(repositoryFullName)) ?? undefined;

      return targetEnvironmentId
        ? {
            repositoryFullName,
            targetEnvironmentId,
          }
        : {
            repositoryFullName,
          };
    }),
  );
}

async function getPersistedSetupNewState() {
  const [settings] = await db
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);

  return normalizeSetupNewState(settings?.setupNewState);
}

async function getSelectedRepositories(
  repositoryIds: string[],
): Promise<Array<{ id: string; fullName: string }>> {
  const { selectedRepositories } = await resolveRepositorySelectionByIds({
    repositoryIds,
    executor: db,
  });

  return selectedRepositories;
}

async function getPersistedTaskSuggestions(
  sourceTaskId: string | null,
): Promise<PersistedTaskSuggestion[]> {
  if (!sourceTaskId) {
    return [];
  }

  return db
    .select({
      id: taskSuggestions.id,
      title: taskSuggestions.title,
      brief: taskSuggestions.brief,
      repositoryIds: taskSuggestions.repositoryIds,
      sortOrder: taskSuggestions.sortOrder,
      dismissedAt: taskSuggestions.dismissedAt,
      targetRepositoryFullName: taskSuggestions.targetRepositoryFullName,
      targetEnvironmentId: taskSuggestions.targetEnvironmentId,
      readinessMessage: taskSuggestions.readinessMessage,
    })
    .from(taskSuggestions)
    .where(eq(taskSuggestions.sourceTaskId, sourceTaskId))
    .orderBy(asc(taskSuggestions.sortOrder));
}

async function getSuggestionTaskStatus(taskId: string | null) {
  if (!taskId) {
    return null;
  }

  const latestCloudJobs = await getLatestCloudJobsByTaskId([taskId]);
  return latestCloudJobs[taskId]?.status ?? null;
}

async function launchSuggestedTasksTask(input: {
  userId: string;
  repositoryIds?: string[];
  repositoryFullNames: string[];
  setupGuidance: string | null;
  trigger: 'onboarding' | 'scheduled';
  notifySlack: boolean;
  currentState: ReturnType<typeof createEmptySetupNewState>;
}) {
  const settings = await getBackgroundAgentSettingsForDeployment();
  const startedAt = new Date().toISOString();
  const repositoryCoverage = await buildRepositoryCoverage(
    input.repositoryFullNames,
  );
  const workspacePayload = buildEnvironmentDefinitionWorkspacePayload(
    input.repositoryFullNames,
  );
  const launchResult = await enqueueCloudTask(
    {
      task: {
        type: TaskPayloadKind.Scan,
        payload: {
          ...workspacePayload,
          ...(input.repositoryIds?.length
            ? { selectedRepositoryIds: input.repositoryIds }
            : {}),
          ...(input.currentState.slackTeamId
            ? { teamId: input.currentState.slackTeamId }
            : {}),
          ...(input.currentState.slackChannel
            ? { slackChannel: input.currentState.slackChannel }
            : {}),
          ...(input.currentState.slackThreadTs
            ? { slackThreadTs: input.currentState.slackThreadTs }
            : {}),
          description: buildSuggestedTasksPrompt({
            repositoryFullNames: input.repositoryFullNames,
            repositoryCoverage,
            setupGuidance: input.setupGuidance,
            suggesterInstructions: settings?.suggesterInstructions ?? null,
          }),
          trigger: input.trigger,
          notifySlack: input.notifySlack,
          visibleInTranscript: false,
        },
      },
      initiator: { kind: 'user', userId: input.userId },
      workflow: 'scan',
      surface: 'web',
      trigger: 'manual',
      visibility: 'hidden',
    },
    {
      // Keepalive parity: scans keep the automation runtime policy they had
      // before the initiator model existed.
      launchClass: 'automation',
    },
  );

  const nextSetupNewState = normalizeSetupNewState({
    ...input.currentState,
    suggestionTaskId: launchResult.taskId,
    suggestionTaskStartedAt: startedAt,
    suggestionGenerationTriggeredAt: startedAt,
    lastInteractedByUserId: input.userId,
  });

  await db
    .insert(deploymentSettings)
    .values({
      id: 'default',
      setupNewState: nextSetupNewState,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        setupNewState: nextSetupNewState,
        updatedAt: new Date(),
      },
    });

  return {
    taskId: launchResult.taskId,
    startedAt,
  };
}

async function clearPersistedSuggestionTask(input: {
  currentState: ReturnType<typeof createEmptySetupNewState>;
}) {
  const nextSetupNewState = normalizeSetupNewState({
    ...input.currentState,
    suggestionTaskId: null,
    suggestionTaskStartedAt: null,
  });

  await db
    .insert(deploymentSettings)
    .values({
      id: 'default',
      setupNewState: nextSetupNewState,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        setupNewState: nextSetupNewState,
        updatedAt: new Date(),
      },
    });

  return nextSetupNewState;
}

async function ensureTaskSuggestions(auth: UserAuthSuccess): Promise<{
  generationStatus: TaskSuggestionGenerationStatus;
  suggestions: PersistedTaskSuggestion[];
}> {
  const setupNewState = await getPersistedSetupNewState();
  const selectedRepositoryIds = setupNewState.selectedRepositoryIds;

  if (selectedRepositoryIds.length === 0) {
    return {
      generationStatus: 'idle',
      suggestions: [],
    };
  }

  const selectedRepositories = await getSelectedRepositories(
    selectedRepositoryIds,
  );

  if (selectedRepositories.length !== selectedRepositoryIds.length) {
    return {
      generationStatus: 'idle',
      suggestions: [],
    };
  }

  const persistedSuggestions = await getPersistedTaskSuggestions(
    setupNewState.suggestionTaskId,
  );
  if (persistedSuggestions.length > 0) {
    return {
      generationStatus: 'ready',
      suggestions: persistedSuggestions,
    };
  }

  const suggestionTaskStatus = await getSuggestionTaskStatus(
    setupNewState.suggestionTaskId,
  );

  let launchState = setupNewState;

  if (setupNewState.suggestionTaskId) {
    if (
      suggestionTaskStatus &&
      !isExitedCloudTaskStatus(suggestionTaskStatus)
    ) {
      return {
        generationStatus: 'pending',
        suggestions: [],
      };
    }

    if (suggestionTaskStatus === CloudTaskStatus.Completed) {
      return {
        generationStatus: 'empty',
        suggestions: [],
      };
    }

    if (
      suggestionTaskStatus === null ||
      (suggestionTaskStatus && isExitedCloudTaskStatus(suggestionTaskStatus))
    ) {
      launchState = await clearPersistedSuggestionTask({
        currentState: setupNewState,
      });
    }
  }

  await launchSuggestedTasksTask({
    userId: auth.userId,
    repositoryIds: selectedRepositoryIds,
    repositoryFullNames: selectedRepositories.map(
      (repository) => repository.fullName,
    ),
    setupGuidance: launchState.setupGuidance,
    trigger: 'onboarding',
    notifySlack: false,
    currentState: launchState,
  });

  return {
    generationStatus: 'pending',
    suggestions: [],
  };
}

export async function listTaskSuggestionsCommand(auth: UserAuthSuccess) {
  const { generationStatus, suggestions } = await ensureTaskSuggestions(auth);

  if (suggestions.length === 0) {
    return {
      generationStatus,
      suggestions: [],
    };
  }

  const visibleSuggestions = suggestions.filter(
    (suggestion) => suggestion.dismissedAt === null,
  );

  return {
    generationStatus,
    suggestions:
      await decorateSuggestionsWithEnvironmentIds(visibleSuggestions),
  };
}

export async function dismissTaskSuggestionCommand(
  auth: UserAuthSuccess,
  input: { suggestionId: string },
) {
  const [suggestion] = await db
    .select({
      id: taskSuggestions.id,
      dismissedAt: taskSuggestions.dismissedAt,
    })
    .from(taskSuggestions)
    .where(eq(taskSuggestions.id, input.suggestionId))
    .limit(1);

  if (!suggestion) {
    throw new Error('Suggestion not found.');
  }

  if (!suggestion.dismissedAt) {
    const dismissedAt = new Date();

    await db
      .update(taskSuggestions)
      .set({
        dismissedAt,
        status: 'dismissed',
        updatedAt: dismissedAt,
      })
      .where(eq(taskSuggestions.id, input.suggestionId));
  }

  return { success: true as const };
}

export async function triggerTaskSuggestionsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const setupNewStateBefore = await getPersistedSetupNewState();
  const beforeTaskId = setupNewStateBefore.suggestionTaskId;

  const { generationStatus } = await ensureTaskSuggestions(auth);
  const setupNewStateAfter = await getPersistedSetupNewState();
  const afterTaskId = setupNewStateAfter.suggestionTaskId;

  return {
    success: true as const,
    generationStatus,
    triggered: Boolean(
      afterTaskId && (!beforeTaskId || beforeTaskId !== afterTaskId),
    ),
    taskId: afterTaskId,
  };
}

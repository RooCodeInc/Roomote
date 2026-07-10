import {
  buildSuggestedTasksPrompt,
  enqueueCloudTask,
  findEnvironmentForRepo,
} from '@roomote/cloud-agents/server';
import {
  and,
  asc,
  db,
  deploymentSettings,
  eq,
  getBackgroundAgentSettingsForDeployment,
  inArray,
  repositories,
  resolveRepositorySelectionByIds,
  workItems,
} from '@roomote/db/server';
import {
  RunStatus,
  TaskPayloadKind,
  buildEnvironmentDefinitionWorkspacePayload,
  createEmptySetupNewState,
  isExitedRunStatus,
  normalizeSetupNewState,
} from '@roomote/types';

import { getLatestCloudJobsByTaskId } from '@/lib/server';
import { resolveSingleSourceControlProvider } from '@/lib/server/source-control-provider';
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

  const rows = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      brief: workItems.brief,
      repositoryIds: workItems.repositoryIds,
      sortOrder: workItems.sortOrder,
      dismissedAt: workItems.dismissedAt,
      targetRepositoryFullName: workItems.targetRepositoryFullName,
      targetEnvironmentId: workItems.targetEnvironmentId,
      readinessMessage: workItems.readinessMessage,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.sourceTaskId, sourceTaskId),
        eq(workItems.kind, 'suggestion'),
      ),
    )
    .orderBy(asc(workItems.sortOrder));

  return rows.map((row) => ({ ...row, brief: row.brief ?? '' }));
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
  // Stamp the provider explicitly: dequeue defaults to GitHub when the
  // payload omits it, which breaks non-GitHub deployments.
  const scanRepositoryRows = await db
    .select({ sourceControlProvider: repositories.sourceControlProvider })
    .from(repositories)
    .where(inArray(repositories.fullName, input.repositoryFullNames));
  const scanSourceControlProvider = resolveSingleSourceControlProvider(
    scanRepositoryRows.map((row) => row.sourceControlProvider),
  );
  const launchResult = await enqueueCloudTask(
    {
      task: {
        type: TaskPayloadKind.Scan,
        payload: {
          ...workspacePayload,
          ...(scanSourceControlProvider
            ? { sourceControlProvider: scanSourceControlProvider }
            : {}),
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
    if (suggestionTaskStatus && !isExitedRunStatus(suggestionTaskStatus)) {
      return {
        generationStatus: 'pending',
        suggestions: [],
      };
    }

    if (suggestionTaskStatus === RunStatus.Completed) {
      return {
        generationStatus: 'empty',
        suggestions: [],
      };
    }

    if (
      suggestionTaskStatus === null ||
      (suggestionTaskStatus && isExitedRunStatus(suggestionTaskStatus))
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
      id: workItems.id,
      dismissedAt: workItems.dismissedAt,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.id, input.suggestionId),
        eq(workItems.kind, 'suggestion'),
      ),
    )
    .limit(1);

  if (!suggestion) {
    throw new Error('Suggestion not found.');
  }

  if (!suggestion.dismissedAt) {
    const dismissedAt = new Date();

    await db
      .update(workItems)
      .set({
        dismissedAt,
        status: 'dismissed',
        updatedAt: dismissedAt,
      })
      .where(eq(workItems.id, input.suggestionId));
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

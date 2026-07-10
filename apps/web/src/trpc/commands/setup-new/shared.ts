import * as GitHub from '@roomote/github';
import {
  db,
  deploymentSettings,
  environments,
  users,
  workItems,
  eq,
  and,
  syncSetupQualificationBlock,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  createEmptySetupNewState,
  normalizeDeploymentModelConfig,
  normalizeSetupNewState,
  type DeploymentModelConfig,
  type SourceControlProvider,
  type TaskModelSettings,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { getLatestCloudJobsByTaskId, getRepositories } from '@/lib/server';
import { areAllRepositoriesEmpty } from '@/lib/repositories';
import {
  findMatchingSetupNewEnvironment,
  normalizeRepositorySelection,
} from '@/lib/setup-new';
import type { QueuedOnboardingTask } from './types';
import { getSetupBootstrapState } from '../setup/shared';

type PersistedSetupNewState = ReturnType<typeof createEmptySetupNewState>;
type PersistedRuntimeModelConfig = DeploymentModelConfig;

export type SelectedRepositorySummary = {
  id: string;
  fullName: string;
  sourceControlProvider: SourceControlProvider;
};

export type PersistedQueuedSetupTask = QueuedOnboardingTask;

export type MutableQueuedSetupTask = PersistedQueuedSetupTask & {
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

export const SETUP_BOOTSTRAP_USER_ID = 'setup-bootstrap-user';

export async function ensureSetupBootstrapAuditUser(
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

export async function assertSetupBootstrapOpen() {
  const bootstrapState = await getSetupBootstrapState();

  if (!bootstrapState.setupOpen) {
    throw new Error('Initial setup is no longer open.');
  }
}

function getSetupQualificationBlockErrorMessage() {
  return 'Setup is currently limited to work email addresses. Use another work email or contact the team if this seems wrong.';
}

export async function getPersistedSetupNewState(
  executor: DatabaseOrTransaction = db,
): Promise<PersistedSetupNewState> {
  const [settings] = await executor
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);

  return normalizeSetupNewState(settings?.setupNewState ?? {});
}

export async function getPersistedRuntimeModelConfig(
  executor: DatabaseOrTransaction = db,
): Promise<PersistedRuntimeModelConfig> {
  const [settings] = await executor
    .select({ runtimeModelConfig: deploymentSettings.runtimeModelConfig })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);

  return normalizeDeploymentModelConfig(settings?.runtimeModelConfig);
}

export async function savePersistedSetupNewState(
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

export async function savePersistedRuntimeModelConfig(
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

export async function savePersistedTaskModelSettings(
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

export async function resolveSelectedRepositories(
  repositoryIds: string[],
): Promise<{
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

export async function assertHasCommittedRepositorySelection(
  repositoryIds: string[],
) {
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

export async function clearTaskSuggestions(
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

export async function clearQueuedSetupTasks(
  executor: DatabaseOrTransaction = db,
) {
  await executor.delete(workItems).where(eq(workItems.kind, 'onboarding'));
}

export function didSuggestionSourceChange({
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

export async function getOnboardingTaskState(taskId: string | null) {
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

export async function getMatchingEnvironmentSummary({
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

export async function getActiveSetupQualificationBlock(
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

export async function assertSetupQualificationNotBlocked(
  auth: UserAuthSuccess,
) {
  const activeSetupQualificationBlock =
    await getActiveSetupQualificationBlock(auth);

  if (!activeSetupQualificationBlock) {
    return;
  }

  throw new Error(getSetupQualificationBlockErrorMessage());
}

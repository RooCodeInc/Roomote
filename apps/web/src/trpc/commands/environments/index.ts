import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  createEnvironmentConfigVersionSnapshot,
  db,
  environmentConfigVersions,
  environments,
  environmentRepositoryMappings,
  taskRuns,
  tasks,
  and,
  beginEnvironmentVerification,
  desc,
  eq,
  inArray,
  isNull,
  loadEnvironmentSnapshots,
  markTaskStartParallelCountEndedAt,
  or,
  repositories,
  sql,
  updateEnvironmentDefinition,
  users,
  withEnvironmentVerificationRetryLock,
  type DatabaseOrTransaction,
  type SQL,
  type EnvironmentConfigVersionSource,
} from '@roomote/db/server';
import {
  activeRunStatuses,
  ALL_REPOSITORIES,
  RunStatus,
  TaskPayloadKind,
  appendEnvironmentDefinitionGuidance,
  buildCreateEnvironmentDefinitionPrompt,
  buildEnvironmentDefinitionWorkspacePayload,
  buildEnvironmentVerificationPrompt,
  type ComputeProvider,
  type EnvironmentConfig,
  environmentConfigSchema,
  getEnvironmentRepositoryConnectionError,
  getMissingEnvironmentRepositoryError,
  isExitedRunStatus,
  normalizeRepositorySelection,
  resolveEvalHarnessSelection,
} from '@roomote/types';
import * as GitHub from '@roomote/github';
import {
  captureActivationEnvironmentSaved,
  captureTaskSettled,
} from '@roomote/telemetry/server';

import { checkRepoAccess } from '@/lib/server';
import type { UserAuthSuccess } from '@/types';
import {
  buildSetupEnvironmentTaskTitle,
  buildUpdateEnvironmentDefinitionPrompt,
} from '@/lib/environment-definition';
import { getRepositories } from '@/lib/server';

export type SnapshotStatus = 'pending' | 'ready' | 'expired' | 'failed';

interface EnvironmentSnapshotWithMeta {
  provider: ComputeProvider;
  snapshotId: string | null;
  snapshotStatus: SnapshotStatus | null;
  snapshotCreatedAt: Date | null;
  snapshotExpiresAt: Date | null;
}

export interface EnvironmentWithMeta {
  id: string;
  name: string;
  description: string | null;
  config: EnvironmentConfig;
  repositoryMappings: Array<{ repositoryId: string }>;
  repositoryCount: number;
  /**
   * Set when the environment is provisioned declaratively at deployment
   * startup (file basename or inline-env-var document reference). Such
   * environments stay editable, but the declarative definition wins again on
   * the next restart.
   */
  declarativeSource: string | null;
  createdAt: Date;
  updatedAt: Date;
  snapshots: Partial<Record<ComputeProvider, EnvironmentSnapshotWithMeta>>;
  /**
   * Verification state. `isVerified` is true once a verification task reported
   * success for the current configuration. `verificationTaskId` links to the
   * Roomote task that most recently ran (or is running) verification.
   * `verificationTaskActive` is true only while that task still has an active
   * run, so the UI can distinguish "verification in progress" from a stale
   * task id left by a crashed or unreported attempt.
   */
  isVerified: boolean;
  verificationTaskId: string | null;
  verificationTaskActive: boolean;
  verifiedAt: Date | null;
  verificationError: string | null;
}

export interface EnvironmentConfigVersionDetail {
  version: number;
  name: string;
  description: string | null;
  source: EnvironmentConfigVersionSource;
  createdByUserId: string | null;
  createdByUserName: string | null;
  createdAt: Date;
  config: EnvironmentConfig;
}

type EnvironmentResult<T = void> =
  | { success: true; data: T; warnings?: string[] }
  | { success: false; error: string };

function buildOwnershipFilter(): SQL<unknown> {
  return isNull(environments.userId);
}

function buildRepositoryOwnershipFilter(): SQL<unknown> {
  return isNull(repositories.userId);
}

function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

type SelectedRepositorySummary = {
  id: string;
  fullName: string;
  sourceControlProvider: string;
  host: string | null;
  installationId: string | null;
};

type EnvironmentRepositoryRow = {
  id: string;
  fullName: string;
  sourceControlProvider: string;
  host: string | null;
  installationId: string | null;
};

function getEnvironmentRepositoryConfigError(
  repositoriesToValidate: EnvironmentRepositoryRow[],
): string | null {
  return getEnvironmentRepositoryConnectionError(
    repositoriesToValidate.map((repository) => ({
      fullName: repository.fullName,
      sourceControlProvider: repository.sourceControlProvider,
      host: repository.host,
      installationId: repository.installationId,
    })),
  );
}

function getConfiguredRepositoryNames(config: EnvironmentConfig): string[] {
  return [
    ...new Set((config.repositories ?? []).map((repo) => repo.repository)),
  ];
}

async function getEnvironmentRepositoryRows(
  repositoryNames: string[],
): Promise<EnvironmentRepositoryRow[]> {
  if (repositoryNames.length === 0) {
    return [];
  }

  return db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
      host: repositories.host,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .where(
      and(
        buildRepositoryOwnershipFilter(),
        eq(repositories.isActive, true),
        inArray(repositories.fullName, repositoryNames),
      ),
    );
}

async function resolveSelectedRepositories(
  auth: UserAuthSuccess,
  repositoryIds: string[],
): Promise<{
  normalizedRepositoryIds: string[];
  selectedRepositories: SelectedRepositorySummary[];
}> {
  const uniqueRepositoryIds = [...new Set(repositoryIds)];
  const availableRepositories = await getRepositories(auth);
  const repositoriesById = new Map(
    availableRepositories.map((repository) => [repository.id, repository]),
  );

  const selectedRepositories = uniqueRepositoryIds.map((repositoryId) => {
    const repository = repositoriesById.get(repositoryId);

    if (!repository) {
      throw new Error('Selected repositories are no longer available.');
    }

    return {
      id: repository.id,
      fullName: repository.fullName,
      sourceControlProvider: repository.sourceControlProvider,
      host: repository.host,
      installationId: repository.installationId,
    };
  });

  const repositoryConfigError =
    getEnvironmentRepositoryConfigError(selectedRepositories);

  if (repositoryConfigError) {
    throw new Error(repositoryConfigError);
  }

  return {
    normalizedRepositoryIds: normalizeRepositorySelection(selectedRepositories),
    selectedRepositories: selectedRepositories.sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    ),
  };
}

function toEnvironmentWithMeta(
  env: typeof environments.$inferSelect,
  snapshots: Partial<Record<ComputeProvider, EnvironmentSnapshotWithMeta>>,
  repositoryMappings: Array<{ repositoryId: string }>,
  activeVerificationTaskIds: Set<string>,
): EnvironmentWithMeta {
  return {
    id: env.id,
    name: env.name,
    description: env.description,
    config: env.config as EnvironmentConfig,
    repositoryMappings,
    repositoryCount:
      (env.config as EnvironmentConfig).repositories?.length ?? 0,
    declarativeSource: env.declarativeSource,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
    snapshots,
    isVerified: env.isVerified,
    verificationTaskId: env.verificationTaskId,
    verificationTaskActive:
      env.verificationTaskId !== null &&
      activeVerificationTaskIds.has(env.verificationTaskId),
    verifiedAt: env.verifiedAt,
    verificationError: env.verificationError,
  };
}

/**
 * Given a set of environments, return the subset of their `verificationTaskId`
 * values that still have an active task run. Used to distinguish an in-progress
 * verification from a stale task id left by a crashed or unreported attempt.
 */
async function getActiveVerificationTaskIds(
  envs: Array<{ verificationTaskId: string | null }>,
): Promise<Set<string>> {
  const taskIds = [
    ...new Set(
      envs
        .map((env) => env.verificationTaskId)
        .filter((taskId): taskId is string => taskId !== null),
    ),
  ];

  if (taskIds.length === 0) {
    return new Set();
  }

  const activeRuns = await db
    .selectDistinct({ taskId: taskRuns.taskId })
    .from(taskRuns)
    .where(
      and(
        inArray(taskRuns.taskId, taskIds),
        inArray(taskRuns.status, [...activeRunStatuses]),
      ),
    );

  return new Set(activeRuns.map((run) => run.taskId));
}

async function getRepositoryMappingsByEnvironmentId(environmentIds: string[]) {
  if (environmentIds.length === 0) {
    return new Map<string, Array<{ repositoryId: string }>>();
  }

  const mappings = await db
    .select({
      environmentId: environmentRepositoryMappings.environmentId,
      repositoryId: environmentRepositoryMappings.repositoryId,
    })
    .from(environmentRepositoryMappings)
    .where(
      inArray(environmentRepositoryMappings.environmentId, environmentIds),
    );

  const mappingsByEnvironmentId = new Map<
    string,
    Array<{ repositoryId: string }>
  >();

  for (const mapping of mappings) {
    const existingMappings =
      mappingsByEnvironmentId.get(mapping.environmentId) ?? [];
    existingMappings.push({ repositoryId: mapping.repositoryId });
    mappingsByEnvironmentId.set(mapping.environmentId, existingMappings);
  }

  return mappingsByEnvironmentId;
}

// --- Queries ---

export async function getEnvironmentsCommand(
  auth: UserAuthSuccess,
): Promise<EnvironmentWithMeta[]> {
  assertAdmin(auth);

  const envs = await db
    .select()
    .from(environments)
    .where(and(buildOwnershipFilter(), eq(environments.isEval, false)))
    .orderBy(desc(environments.updatedAt));

  const snapshotsByEnvironment = await loadEnvironmentSnapshots(envs);
  const repositoryMappingsByEnvironmentId =
    await getRepositoryMappingsByEnvironmentId(
      envs.map((environment) => environment.id),
    );
  const activeVerificationTaskIds = await getActiveVerificationTaskIds(envs);

  return envs.map((env) =>
    toEnvironmentWithMeta(
      env,
      snapshotsByEnvironment.get(env.id) ?? {},
      repositoryMappingsByEnvironmentId.get(env.id) ?? [],
      activeVerificationTaskIds,
    ),
  );
}

/** Member workspace selection intentionally exposes no configuration or state. */
export async function getAvailableEnvironmentsCommand(
  _auth: UserAuthSuccess,
  input?: { repository?: string },
): Promise<Array<{ id: string; name: string }>> {
  const envs = await db
    .select({
      id: environments.id,
      name: environments.name,
      config: environments.config,
    })
    .from(environments)
    .where(and(buildOwnershipFilter(), eq(environments.isEval, false)))
    .orderBy(desc(environments.updatedAt));

  return envs
    .filter((environment) =>
      input?.repository
        ? (environment.config as EnvironmentConfig).repositories?.some(
            (repository) => repository.repository === input.repository,
          )
        : true,
    )
    .map(({ id, name }) => ({ id, name }));
}

export async function getEnvironmentNamesByIdsCommand(
  auth: UserAuthSuccess,
  input: { ids: string[] },
): Promise<Array<{ id: string; name: string }>> {
  const uniqueIds = [...new Set(input.ids)];

  if (uniqueIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: environments.id,
      name: environments.name,
    })
    .from(environments)
    .where(
      and(
        buildOwnershipFilter(),
        eq(environments.isEval, false),
        inArray(environments.id, uniqueIds),
      ),
    );

  const namesById = new Map(
    rows.map((environment) => [environment.id, environment]),
  );

  return uniqueIds.flatMap((id) => {
    const environment = namesById.get(id);
    return environment ? [environment] : [];
  });
}

export async function getEnvironmentByIdCommand(
  auth: UserAuthSuccess,
  input: { id: string },
): Promise<EnvironmentWithMeta | null> {
  assertAdmin(auth);

  const [env] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.id, input.id), buildOwnershipFilter()))
    .limit(1);

  if (!env) {
    return null;
  }

  const snapshotsByEnvironment = await loadEnvironmentSnapshots([env]);
  const repositoryMappingsByEnvironmentId =
    await getRepositoryMappingsByEnvironmentId([env.id]);
  const activeVerificationTaskIds = await getActiveVerificationTaskIds([env]);

  return toEnvironmentWithMeta(
    env,
    snapshotsByEnvironment.get(env.id) ?? {},
    repositoryMappingsByEnvironmentId.get(env.id) ?? [],
    activeVerificationTaskIds,
  );
}

// --- Mutations ---

export async function createEnvironmentCommand(
  auth: UserAuthSuccess,
  input: {
    name: string;
    description?: string;
    config: EnvironmentConfig;
  },
): Promise<EnvironmentResult<{ id: string }>> {
  assertAdmin(auth);
  const { userId } = auth;

  const parseResult = environmentConfigSchema.safeParse(input.config);

  if (!parseResult.success) {
    return {
      success: false,
      error: `Invalid configuration: ${parseResult.error.issues.map((i) => i.message).join(', ')}`,
    };
  }

  const [existing] = await db
    .select()
    .from(environments)
    .where(and(buildOwnershipFilter(), eq(environments.name, input.name)))
    .limit(1);

  if (existing) {
    return {
      success: false,
      error: 'An environment with this name already exists',
    };
  }

  const configRepos = parseResult.data.repositories ?? [];
  const repositoryNames = getConfiguredRepositoryNames(parseResult.data);
  const repositoryRows = await getEnvironmentRepositoryRows(repositoryNames);
  const repositoryConfigError =
    getEnvironmentRepositoryConfigError(repositoryRows);

  if (repositoryConfigError) {
    return { success: false, error: repositoryConfigError };
  }

  const missingRepositoryError = getMissingEnvironmentRepositoryError(
    repositoryNames,
    repositoryRows,
  );

  if (missingRepositoryError) {
    return { success: false, error: missingRepositoryError };
  }

  const repoMap = new Map(repositoryRows.map((r) => [r.fullName, r.id]));

  const result: EnvironmentResult<{ id: string }> = await db.transaction(
    async (tx) => {
      const [created] = await tx
        .insert(environments)
        .values({
          userId: undefined,
          name: input.name,
          description: input.description,
          config: parseResult.data,
          createdByUserId: userId,
          // New environments start configured but not yet verified.
          isVerified: false,
          verificationError: null,
        })
        .returning({ id: environments.id });

      if (!created) {
        return { success: false, error: 'Failed to create environment' };
      }

      await createEnvironmentConfigVersionSnapshot(tx, {
        environmentId: created.id,
        config: parseResult.data,
        name: input.name,
        description: input.description ?? null,
        source: 'user',
        createdByUserId: userId,
      });

      if (configRepos.length > 0) {
        const mappings = configRepos
          .filter((configRepo) => repoMap.has(configRepo.repository))
          .map((configRepo) => ({
            environmentId: created.id,
            repositoryId: repoMap.get(configRepo.repository)!,
          }));

        if (mappings.length > 0) {
          await tx.insert(environmentRepositoryMappings).values(mappings);
        }
      }

      return { success: true, data: { id: created.id } };
    },
  );

  if (result.success) {
    void captureActivationEnvironmentSaved('settings');
  }

  return result;
}

export async function updateEnvironmentCommand(
  auth: UserAuthSuccess,
  input: {
    id: string;
    name?: string;
    description?: string;
    agentInstructions?: string;
    config?: EnvironmentConfig;
    source?: EnvironmentConfigVersionSource;
  },
): Promise<EnvironmentResult> {
  assertAdmin(auth);

  const [env] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.id, input.id), buildOwnershipFilter()))
    .limit(1);

  if (!env) {
    return { success: false, error: 'Environment not found' };
  }

  let nextConfig: EnvironmentConfig | undefined;

  if (input.config) {
    const parseResult = environmentConfigSchema.safeParse(input.config);

    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid configuration: ${parseResult.error.issues.map((i) => i.message).join(', ')}`,
      };
    }

    nextConfig = parseResult.data;
  } else if (
    input.name !== undefined ||
    input.description !== undefined ||
    input.agentInstructions !== undefined
  ) {
    const parseResult = environmentConfigSchema.safeParse({
      ...(env.config as EnvironmentConfig),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description || undefined }
        : {}),
      ...(input.agentInstructions !== undefined
        ? { agentInstructions: input.agentInstructions || undefined }
        : {}),
    });

    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid configuration: ${parseResult.error.issues.map((i) => i.message).join(', ')}`,
      };
    }

    nextConfig = parseResult.data;
  }

  if (input.name && input.name !== env.name) {
    const [existing] = await db
      .select()
      .from(environments)
      .where(and(buildOwnershipFilter(), eq(environments.name, input.name)))
      .limit(1);

    if (existing) {
      return {
        success: false,
        error: 'An environment with this name already exists',
      };
    }
  }

  const configRepos = nextConfig?.repositories ?? [];
  const repositoryNames =
    input.config && nextConfig ? getConfiguredRepositoryNames(nextConfig) : [];
  const repositoryRows = input.config
    ? await getEnvironmentRepositoryRows(repositoryNames)
    : [];
  const repositoryConfigError =
    getEnvironmentRepositoryConfigError(repositoryRows);

  if (repositoryConfigError) {
    return { success: false, error: repositoryConfigError };
  }

  const missingRepositoryError = getMissingEnvironmentRepositoryError(
    repositoryNames,
    repositoryRows,
  );

  if (missingRepositoryError) {
    return { success: false, error: missingRepositoryError };
  }

  const repoMap = new Map(repositoryRows.map((r) => [r.fullName, r.id]));
  const shouldSnapshotConfig = nextConfig !== undefined;

  return db.transaction(async (tx) => {
    const now = new Date();
    const updateData: {
      name?: string;
      description?: string | null;
      config?: EnvironmentConfig;
    } = {};

    if (input.name !== undefined) {
      updateData.name = input.name;
    }

    if (input.description !== undefined) {
      updateData.description = input.description || null;
    }

    if (nextConfig !== undefined) {
      updateData.config = nextConfig;
    }

    const repositoryIds =
      input.config && configRepos.length > 0
        ? configRepos
            .filter((configRepo) => repoMap.has(configRepo.repository))
            .map((configRepo) => repoMap.get(configRepo.repository)!)
        : input.config
          ? []
          : undefined;

    await updateEnvironmentDefinition(tx, {
      environmentId: input.id,
      fields: updateData,
      updatedAt: now,
      repositoryIds,
      configVersion:
        shouldSnapshotConfig && nextConfig !== undefined
          ? {
              config: nextConfig,
              name: nextConfig.name,
              description: nextConfig.description ?? null,
              source: input.source ?? 'user',
              createdByUserId: auth.userId,
            }
          : undefined,
    });

    return { success: true, data: undefined };
  });
}

export async function listEnvironmentConfigVersionsCommand(
  auth: UserAuthSuccess,
  input: { environmentId: string },
): Promise<Array<Omit<EnvironmentConfigVersionDetail, 'config'>>> {
  assertAdmin(auth);

  const [environment] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(eq(environments.id, input.environmentId), buildOwnershipFilter()),
    )
    .limit(1);

  if (!environment) {
    return [];
  }

  return db
    .select({
      version: environmentConfigVersions.version,
      name: environmentConfigVersions.name,
      description: environmentConfigVersions.description,
      source: environmentConfigVersions.source,
      createdByUserId: environmentConfigVersions.createdByUserId,
      createdByUserName: users.name,
      createdAt: environmentConfigVersions.createdAt,
    })
    .from(environmentConfigVersions)
    .leftJoin(users, eq(environmentConfigVersions.createdByUserId, users.id))
    .where(eq(environmentConfigVersions.environmentId, input.environmentId))
    .orderBy(desc(environmentConfigVersions.version));
}

export async function getEnvironmentConfigVersionCommand(
  auth: UserAuthSuccess,
  input: { environmentId: string; version: number },
): Promise<EnvironmentConfigVersionDetail | null> {
  assertAdmin(auth);

  const [versionRow] = await db
    .select({
      version: environmentConfigVersions.version,
      config: environmentConfigVersions.config,
      name: environmentConfigVersions.name,
      description: environmentConfigVersions.description,
      source: environmentConfigVersions.source,
      createdByUserId: environmentConfigVersions.createdByUserId,
      createdByUserName: users.name,
      createdAt: environmentConfigVersions.createdAt,
    })
    .from(environmentConfigVersions)
    .innerJoin(
      environments,
      eq(environmentConfigVersions.environmentId, environments.id),
    )
    .leftJoin(users, eq(environmentConfigVersions.createdByUserId, users.id))
    .where(
      and(
        eq(environmentConfigVersions.environmentId, input.environmentId),
        eq(environmentConfigVersions.version, input.version),
        buildOwnershipFilter(),
      ),
    )
    .limit(1);

  return versionRow
    ? {
        ...versionRow,
        config: versionRow.config as EnvironmentConfig,
      }
    : null;
}

export async function getActiveEnvironmentDefinitionTaskCommand(
  auth: UserAuthSuccess,
  input: { environmentId: string },
): Promise<{ taskId: string } | null> {
  assertAdmin(auth);

  const [job] = await db
    .select({
      taskId: taskRuns.taskId,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.workflow, 'setup_onboarding'),
        inArray(taskRuns.status, [...activeRunStatuses]),
        sql`${taskRuns.payload} ->> 'environmentDefinitionId' = ${input.environmentId}`,
      ),
    )
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(1);

  return job ?? null;
}

export async function startEnvironmentDefinitionTaskCommand(
  auth: UserAuthSuccess,
  input: {
    repositoryIds: string[];
    environmentId?: string;
    changeRequest?: string;
    selectedModelId?: string;
  },
) {
  assertAdmin(auth);

  if (input.repositoryIds.length === 0) {
    throw new Error('Select at least one repository before starting setup.');
  }

  const { userId } = auth;
  const { selectedRepositories } = await resolveSelectedRepositories(
    auth,
    input.repositoryIds,
  );

  const selectedRepositoryFullNames = selectedRepositories.map(
    (repository) => repository.fullName,
  );
  const title = buildSetupEnvironmentTaskTitle(selectedRepositoryFullNames);
  const workspacePayload = buildEnvironmentDefinitionWorkspacePayload(
    selectedRepositoryFullNames,
  );
  const modelSelection = resolveEvalHarnessSelection({
    model: input.selectedModelId,
  });

  if (!modelSelection.ok) {
    throw new Error(modelSelection.error);
  }

  let prompt = buildCreateEnvironmentDefinitionPrompt(
    selectedRepositoryFullNames,
  );

  if (input.environmentId) {
    const [environment] = await db
      .select({
        id: environments.id,
        name: environments.name,
        config: environments.config,
      })
      .from(environments)
      .where(
        and(eq(environments.id, input.environmentId), buildOwnershipFilter()),
      )
      .limit(1);

    if (!environment) {
      throw new Error('Environment not found');
    }

    prompt = buildUpdateEnvironmentDefinitionPrompt({
      environmentId: environment.id,
      environmentName: environment.name,
      repositoryFullNames: selectedRepositoryFullNames,
      config: environment.config as EnvironmentConfig,
    });
  }

  prompt = appendEnvironmentDefinitionGuidance(
    prompt,
    input.changeRequest,
    input.environmentId
      ? 'Requested changes from the user:'
      : 'Additional setup guidance from the user:',
  );

  const startedAt = new Date().toISOString();
  const launchResult = await enqueueTask({
    title,
    task: {
      ...(modelSelection.harness ? { harness: modelSelection.harness } : {}),
      type: TaskPayloadKind.StandardTask,
      payload: {
        ...workspacePayload,
        ...(input.environmentId
          ? { environmentDefinitionId: input.environmentId }
          : {}),
        description: prompt,
        ...(modelSelection.harnessModelOverrides
          ? { harnessModelOverrides: modelSelection.harnessModelOverrides }
          : {}),
      },
    },
    initiator: { kind: 'user', userId },
    workflow: 'setup_onboarding',
    surface: 'web',
    trigger: 'manual',
  });

  return {
    taskId: launchResult.taskId,
    runId: launchResult.id,
    startedAt,
  };
}

/**
 * Find an active verification task for the given environment, if any. This
 * covers both retry-launched verification tasks (marked with
 * `verifiesEnvironmentId`) and the initial onboarding setup task (workflow
 * `setup_onboarding`, marked with `environmentDefinitionId`) that performs and
 * records the first verification. Both are explicitly authorized to record a
 * result for the environment, so both must block a concurrent retry from
 * superseding an in-flight attempt. Accepts a transaction so the check can run
 * inside the retry critical section.
 */
async function getActiveVerificationTaskId(
  dbOrTx: DatabaseOrTransaction,
  environmentId: string,
): Promise<string | null> {
  return (
    (await getActiveEnvironmentAgentTask(dbOrTx, environmentId))?.taskId ?? null
  );
}

/**
 * Find the active agent task working on the given environment, if any: either
 * a retry-launched verification task (`verifiesEnvironmentId`) or a
 * setup/definition task (workflow `setup_onboarding` with
 * `environmentDefinitionId`). Shared by the verification-retry guard and the
 * preview-setup CTA so neither launches a duplicate agent while one is
 * in flight.
 *
 * `isPreviewSetupTask` distinguishes preview setup/repair agents (definition
 * tasks that run inside the environment, i.e. payload `environmentId` matches)
 * from the initial environment-creation task, which is necessarily repo-only,
 * and from verification retries.
 */
export async function getActiveEnvironmentAgentTask(
  dbOrTx: DatabaseOrTransaction,
  environmentId: string,
): Promise<{
  taskId: string;
  status: RunStatus;
  taskPhase: string | null;
  isPreviewSetupTask: boolean;
} | null> {
  const [job] = await dbOrTx
    .select({
      taskId: taskRuns.taskId,
      status: taskRuns.status,
      taskPhase: taskRuns.taskPhase,
      isPreviewSetupTask: sql<boolean>`(
        ${tasks.workflow} = 'setup_onboarding'
        AND ${taskRuns.payload} ->> 'environmentDefinitionId' = ${environmentId}
        AND ${taskRuns.payload} ->> 'environmentId' = ${environmentId}
      )`,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        inArray(taskRuns.status, [...activeRunStatuses]),
        or(
          sql`${taskRuns.payload} ->> 'verifiesEnvironmentId' = ${environmentId}`,
          and(
            eq(tasks.workflow, 'setup_onboarding'),
            sql`${taskRuns.payload} ->> 'environmentDefinitionId' = ${environmentId}`,
          ),
        ),
      ),
    )
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(1);

  return job ?? null;
}

/**
 * Test-only export of the active-verification-attempt guard so its
 * environment-marker matching (retry `verifiesEnvironmentId` and onboarding
 * `setup_onboarding` + `environmentDefinitionId`) can be verified against a
 * real database.
 */
export async function getActiveVerificationTaskIdForTest(
  dbOrTx: DatabaseOrTransaction,
  environmentId: string,
): Promise<string | null> {
  return getActiveVerificationTaskId(dbOrTx, environmentId);
}

/**
 * Re-run environment verification: enqueue a standard task that runs inside the
 * target environment, verifies it, and records the result through the
 * `record_verification` MCP action. Resets the environment to the unverified
 * state and stores the new verification task id.
 *
 * The active-run check, task enqueue, and attempt registration are serialized
 * per environment by a `withEnvironmentVerificationRetryLock` advisory lock, so
 * two concurrent retries cannot both pass the check and enqueue duplicate
 * verification runs; the second waits for the first to commit and then sees the
 * active attempt and is rejected. The attempt is registered in `enqueueTask`'s
 * `afterCreateInTransaction` hook, so the environment's `verificationTaskId`
 * commits atomically with the run row and before the run is queued — avoiding a
 * race where the run's `record_verification` is rejected as a mismatched
 * attempt because the claim had not committed yet.
 */
export async function retryEnvironmentVerificationCommand(
  auth: UserAuthSuccess,
  input: { environmentId: string },
): Promise<{ taskId: string }> {
  assertAdmin(auth);

  const { userId } = auth;

  const [environment] = await db
    .select({
      id: environments.id,
      name: environments.name,
    })
    .from(environments)
    .where(
      and(eq(environments.id, input.environmentId), buildOwnershipFilter()),
    )
    .limit(1);

  if (!environment) {
    throw new Error('Environment not found');
  }

  const prompt = buildEnvironmentVerificationPrompt({
    environmentId: environment.id,
    environmentName: environment.name,
  });

  return withEnvironmentVerificationRetryLock(environment.id, async (tx) => {
    const activeVerificationTaskId = await getActiveVerificationTaskId(
      tx,
      environment.id,
    );

    if (activeVerificationTaskId) {
      throw new Error('This environment is already being verified.');
    }

    const launchResult = await enqueueTask(
      {
        title: `Verify environment: ${environment.name}`,
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: ALL_REPOSITORIES,
            environmentId: environment.id,
            verifiesEnvironmentId: environment.id,
            description: prompt,
          },
        },
        initiator: { kind: 'user', userId },
        workflow: 'standard',
        surface: 'web',
        trigger: 'manual',
      },
      {
        // Claim this verification attempt inside enqueue's own run-creation
        // transaction, so the task id and the environment's verificationTaskId
        // commit atomically with the run row and before the run is pushed onto
        // the controller queue. `beforeEnqueue` (or writing through the outer
        // advisory-lock transaction) is not sufficient here: the run row is
        // committed by enqueue's transaction before the outer transaction
        // commits, so the controller could start the run and call
        // record_verification before the claim is visible, yielding a
        // mismatched-attempt rejection.
        afterCreateInTransaction: async (enqueueTx, taskRun) => {
          await beginEnvironmentVerification(enqueueTx, {
            environmentId: environment.id,
            verificationTaskId: taskRun.taskId,
          });
        },
      },
    );

    return { taskId: launchResult.taskId };
  });
}

export async function cancelEnvironmentDefinitionTaskCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
) {
  assertAdmin(auth);

  const jobs = await db
    .select({
      id: taskRuns.id,
      status: taskRuns.status,
    })
    .from(taskRuns)
    .where(eq(taskRuns.taskId, input.taskId));

  const activeRunIds = jobs
    .filter((job) => !isExitedRunStatus(job.status))
    .map((job) => job.id);

  if (activeRunIds.length === 0) {
    return { success: true as const };
  }

  const endedAt = new Date();

  const canceledRuns = await db.transaction(async (tx) => {
    const canceled = await tx
      .update(taskRuns)
      .set({
        status: RunStatus.Canceled,
        canceledAt: endedAt,
      })
      .where(inArray(taskRuns.id, activeRunIds))
      .returning({ id: taskRuns.id });

    await Promise.all(
      canceled.map((run) =>
        markTaskStartParallelCountEndedAt(tx, {
          runId: run.id,
          endedAt,
        }),
      ),
    );

    return canceled;
  });

  for (const run of canceledRuns) {
    void captureTaskSettled(run.id, 'canceled');
  }

  return { success: true as const };
}

export async function deleteEnvironmentCommand(
  auth: UserAuthSuccess,
  input: { id: string },
): Promise<EnvironmentResult> {
  assertAdmin(auth);

  const [env] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.id, input.id), buildOwnershipFilter()))
    .limit(1);

  if (!env) {
    return { success: false, error: 'Environment not found' };
  }

  return db.transaction(async (tx) => {
    await tx
      .delete(environmentRepositoryMappings)
      .where(eq(environmentRepositoryMappings.environmentId, input.id));

    await tx.delete(environments).where(eq(environments.id, input.id));

    return { success: true, data: undefined };
  });
}

export async function duplicateEnvironmentCommand(
  auth: UserAuthSuccess,
  input: { id: string; newName: string },
): Promise<EnvironmentResult<{ id: string }>> {
  assertAdmin(auth);

  const env = await getEnvironmentByIdCommand(auth, { id: input.id });

  if (!env) {
    return { success: false, error: 'Environment not found' };
  }

  return createEnvironmentCommand(auth, {
    name: input.newName,
    description: env.description ?? undefined,
    config: { ...env.config, name: input.newName },
  });
}

// --- Validation ---

/**
 * Validates an environment configuration asynchronously against server-side
 * resources. Checks repository accessibility (hard error) and branch existence
 * for providers with a branch-listing implementation (soft warning).
 */
export async function validateConfigCommand(
  auth: UserAuthSuccess,
  input: { config: EnvironmentConfig },
): Promise<{ errors: string[]; warnings: string[] }> {
  const { userId } = auth;

  const errors: string[] = [];
  const warnings: string[] = [];
  const repositoryProviders = new Map<
    string,
    (typeof repositories.$inferSelect)['sourceControlProvider']
  >();
  const repositoryNames = [
    ...new Set(input.config.repositories.map((repo) => repo.repository)),
  ];

  if (repositoryNames.length > 0) {
    const dbRepos = await db
      .select({
        id: repositories.id,
        fullName: repositories.fullName,
        installationId: repositories.installationId,
        sourceControlProvider: repositories.sourceControlProvider,
        host: repositories.host,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.isActive, true),
          inArray(repositories.fullName, repositoryNames),
        ),
      );

    const repositoryConfigError = getEnvironmentRepositoryConfigError(dbRepos);

    if (repositoryConfigError) {
      errors.push(repositoryConfigError);
    }

    for (const repository of dbRepos) {
      repositoryProviders.set(
        repository.fullName,
        repository.sourceControlProvider,
      );
    }
  }

  await Promise.all(
    input.config.repositories.map(async (repo) => {
      const hasAccess = await checkRepoAccess(repo.repository);

      if (!hasAccess) {
        errors.push(
          `Repository '${repo.repository}' is not accessible. Ensure it is installed via the GitHub App.`,
        );
        return; // skip branch check if repo itself is inaccessible
      }

      // Branch listing is currently implemented only for GitHub. Do not send
      // repositories from other providers through the GitHub API: its
      // provider-scoped lookup correctly returns no branches for those rows.
      if (
        repo.branch &&
        repositoryProviders.get(repo.repository) === 'github'
      ) {
        try {
          const branches = await GitHub.getBranches({
            userId,
            fullName: repo.repository,
          });

          if (!branches.includes(repo.branch)) {
            warnings.push(
              `Branch '${repo.branch}' was not found in '${repo.repository}'. It may not exist yet.`,
            );
          }
        } catch {
          warnings.push(
            `Could not verify branch '${repo.branch}' for '${repo.repository}'.`,
          );
        }
      }
    }),
  );

  return { errors, warnings };
}

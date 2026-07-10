import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import {
  createEnvironmentConfigVersionSnapshot,
  db,
  environmentConfigVersions,
  environments,
  environmentRepositoryMappings,
  taskRuns,
  tasks,
  and,
  desc,
  eq,
  inArray,
  isNull,
  loadEnvironmentSnapshots,
  markTaskStartParallelCountEndedAt,
  repositories,
  sql,
  updateEnvironmentDefinition,
  users,
  type SQL,
  type EnvironmentConfigVersionSource,
} from '@roomote/db/server';
import {
  activeCloudTaskStatuses,
  CloudTaskStatus,
  TaskPayloadKind,
  appendEnvironmentDefinitionGuidance,
  buildCreateEnvironmentDefinitionPrompt,
  buildEnvironmentDefinitionWorkspacePayload,
  type ComputeProvider,
  type EnvironmentConfig,
  environmentConfigSchema,
  getEnvironmentRepositoryInstallationError,
  isExitedCloudTaskStatus,
  normalizeRepositorySelection,
} from '@roomote/types';
import * as GitHub from '@roomote/github';

import { checkRepoAccess } from '@/lib/server';
import type { UserAuthSuccess } from '@/types';
import { buildUpdateEnvironmentDefinitionPrompt } from '@/lib/environment-definition';
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
  installationId: string | null;
};

type EnvironmentRepositoryRow = {
  id: string;
  fullName: string;
  installationId: string | null;
};

function getEnvironmentRepositoryConfigError(
  repositoriesToValidate: EnvironmentRepositoryRow[],
): string | null {
  return getEnvironmentRepositoryInstallationError(
    repositoriesToValidate.map((repository) => ({
      fullName: repository.fullName,
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
  };
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

  return envs.map((env) =>
    toEnvironmentWithMeta(
      env,
      snapshotsByEnvironment.get(env.id) ?? {},
      repositoryMappingsByEnvironmentId.get(env.id) ?? [],
    ),
  );
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

  return toEnvironmentWithMeta(
    env,
    snapshotsByEnvironment.get(env.id) ?? {},
    repositoryMappingsByEnvironmentId.get(env.id) ?? [],
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
  const repositoryRows = await getEnvironmentRepositoryRows(
    getConfiguredRepositoryNames(parseResult.data),
  );
  const repositoryConfigError =
    getEnvironmentRepositoryConfigError(repositoryRows);

  if (repositoryConfigError) {
    return { success: false, error: repositoryConfigError };
  }

  const repoMap = new Map(repositoryRows.map((r) => [r.fullName, r.id]));

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(environments)
      .values({
        userId: undefined,
        name: input.name,
        description: input.description,
        config: parseResult.data,
        createdByUserId: userId,
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
  });
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
  const repositoryRows = input.config
    ? await getEnvironmentRepositoryRows(
        nextConfig ? getConfiguredRepositoryNames(nextConfig) : [],
      )
    : [];
  const repositoryConfigError =
    getEnvironmentRepositoryConfigError(repositoryRows);

  if (repositoryConfigError) {
    return { success: false, error: repositoryConfigError };
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
        eq(tasks.workflow, 'standard'),
        inArray(taskRuns.status, [...activeCloudTaskStatuses]),
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
  const workspacePayload = buildEnvironmentDefinitionWorkspacePayload(
    selectedRepositoryFullNames,
  );

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
  const launchResult = await enqueueCloudTask({
    task: {
      type: TaskPayloadKind.StandardTask,
      payload: {
        ...workspacePayload,
        ...(input.environmentId
          ? { environmentDefinitionId: input.environmentId }
          : {}),
        description: prompt,
        visibleInTranscript: false,
      },
    },
    initiator: { kind: 'user', userId },
    workflow: 'standard',
    surface: 'web',
    trigger: 'manual',
  });

  return {
    taskId: launchResult.taskId,
    cloudJobId: launchResult.id,
    startedAt,
  };
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

  const activeJobIds = jobs
    .filter((job) => !isExitedCloudTaskStatus(job.status))
    .map((job) => job.id);

  if (activeJobIds.length === 0) {
    return { success: true as const };
  }

  const endedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(taskRuns)
      .set({
        status: CloudTaskStatus.Canceled,
        canceledAt: endedAt,
      })
      .where(inArray(taskRuns.id, activeJobIds));

    await Promise.all(
      activeJobIds.map((runId) =>
        markTaskStartParallelCountEndedAt(tx, {
          runId,
          endedAt,
        }),
      ),
    );
  });

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
 * resources. Checks repository accessibility via the GitHub API (hard error)
 * and branch existence (soft warning).
 */
export async function validateConfigCommand(
  auth: UserAuthSuccess,
  input: { config: EnvironmentConfig },
): Promise<{ errors: string[]; warnings: string[] }> {
  const { userId } = auth;

  const errors: string[] = [];
  const warnings: string[] = [];
  const repositoryNames = [
    ...new Set(input.config.repositories.map((repo) => repo.repository)),
  ];

  if (repositoryNames.length > 0) {
    const dbRepos = await db
      .select({
        id: repositories.id,
        fullName: repositories.fullName,
        installationId: repositories.installationId,
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

      // If a branch is specified, check it exists
      if (repo.branch) {
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

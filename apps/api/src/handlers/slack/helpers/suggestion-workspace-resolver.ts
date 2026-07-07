import { type EnvironmentConfig } from '@roomote/types';
import {
  and,
  db,
  environments,
  eq,
  inArray,
  repositories,
} from '@roomote/db/server';

export type SuggestionLaunchWorkspace = {
  repoForPayload: string;
  environmentId?: string;
  workspaceDisplayName: string;
  readinessMessage?: string | null;
};

function toComparableTimestamp(value: Date | string | null): number {
  if (!value) {
    return Number.NaN;
  }

  return new Date(value).getTime();
}

function environmentIncludesRepositorySet(
  config: EnvironmentConfig,
  selectedRepositoryFullNames: string[],
): boolean {
  if (selectedRepositoryFullNames.length === 0) {
    return false;
  }

  const configuredRepositories = new Set(
    (config.repositories ?? []).map((repository) =>
      repository.repository.toLowerCase(),
    ),
  );

  return selectedRepositoryFullNames.every((repositoryFullName) =>
    configuredRepositories.has(repositoryFullName.toLowerCase()),
  );
}

function getConfiguredRepositoryFullNames(config: EnvironmentConfig): string[] {
  return (config.repositories ?? [])
    .map((repository) => repository?.repository)
    .filter(
      (repositoryFullName): repositoryFullName is string =>
        typeof repositoryFullName === 'string' && repositoryFullName.length > 0,
    );
}

export function repositoryIdsMatchSelection(
  suggestionRepositoryIds: string[],
  selectedRepositoryIds: string[],
): boolean {
  return (
    suggestionRepositoryIds.length === selectedRepositoryIds.length &&
    suggestionRepositoryIds.every(
      (repositoryId, index) => repositoryId === selectedRepositoryIds[index],
    )
  );
}

export async function findMatchingEnvironmentIdForRepositoryIds(input: {
  repositoryIds: string[];
  minimumCreatedAt?: string | null;
}): Promise<{
  id: string;
  name: string;
  repoForPayload: string;
  configuredRepositoryFullNames: string[];
} | null> {
  const selectedRepositoryIds = input.repositoryIds;

  if (selectedRepositoryIds.length === 0) {
    return null;
  }

  const repositoryRows = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(inArray(repositories.id, selectedRepositoryIds))
    .limit(selectedRepositoryIds.length);

  const repositoriesById = new Map(
    repositoryRows.map((repository) => [repository.id, repository.fullName]),
  );
  const selectedRepositoryFullNames = selectedRepositoryIds
    .map((repositoryId) => repositoriesById.get(repositoryId))
    .filter((repositoryFullName): repositoryFullName is string =>
      Boolean(repositoryFullName),
    );

  if (selectedRepositoryFullNames.length !== selectedRepositoryIds.length) {
    return null;
  }

  const environmentRows = await db
    .select({
      id: environments.id,
      name: environments.name,
      config: environments.config,
      createdAt: environments.createdAt,
    })
    .from(environments)
    .where(eq(environments.isEval, false))
    .limit(500);

  const minimumCreatedAtMs =
    input.minimumCreatedAt === undefined || input.minimumCreatedAt === null
      ? null
      : toComparableTimestamp(input.minimumCreatedAt);

  const matchingEnvironment = environmentRows
    .filter((environment) => {
      if (
        !environmentIncludesRepositorySet(
          environment.config,
          selectedRepositoryFullNames,
        )
      ) {
        return false;
      }

      if (minimumCreatedAtMs === null) {
        return true;
      }

      const createdAtMs = toComparableTimestamp(environment.createdAt);

      return Number.isFinite(createdAtMs) && createdAtMs >= minimumCreatedAtMs;
    })
    .sort(
      (left, right) =>
        toComparableTimestamp(left.createdAt) -
        toComparableTimestamp(right.createdAt),
    )[0];

  const configuredRepositoryFullNames = matchingEnvironment
    ? getConfiguredRepositoryFullNames(matchingEnvironment.config)
    : [];
  const firstRepo = configuredRepositoryFullNames[0] ?? null;

  return matchingEnvironment && typeof firstRepo === 'string'
    ? {
        id: matchingEnvironment.id,
        name: matchingEnvironment.name,
        repoForPayload: firstRepo,
        configuredRepositoryFullNames,
      }
    : null;
}

/**
 * Resolves a launch workspace for a scheduled (non-onboarding) suggestion from
 * the launch metadata persisted on the suggestion itself. Scheduled
 * suggestions carry their own `targetRepositoryFullName` and, when
 * environment-backed, `targetEnvironmentId`, so the workspace can be resolved
 * without the onboarding selection state used by setup suggestions.
 */
export async function resolveSuggestionLaunchWorkspaceFromMetadata(input: {
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  readinessMessage?: string | null;
}): Promise<{
  workspace: SuggestionLaunchWorkspace | null;
  failureReason: string | null;
}> {
  const targetRepositoryFullName =
    input.targetRepositoryFullName?.trim() || null;

  if (!targetRepositoryFullName) {
    return {
      workspace: null,
      failureReason:
        "I couldn't start this suggestion because it does not have a target repository.",
    };
  }

  const readinessMessage = input.readinessMessage ?? null;

  if (!input.targetEnvironmentId) {
    return {
      workspace: {
        repoForPayload: targetRepositoryFullName,
        workspaceDisplayName: targetRepositoryFullName,
        readinessMessage,
      },
      failureReason: null,
    };
  }

  const [environment] = await db
    .select({
      id: environments.id,
      name: environments.name,
      config: environments.config,
    })
    .from(environments)
    .where(
      and(
        eq(environments.id, input.targetEnvironmentId),
        eq(environments.isEval, false),
      ),
    )
    .limit(1);

  if (!environment) {
    return {
      workspace: null,
      failureReason:
        "I couldn't start this suggestion because its environment is no longer available.",
    };
  }

  const configuredRepositoryFullNames = getConfiguredRepositoryFullNames(
    environment.config,
  );
  const includesTargetRepository = configuredRepositoryFullNames.some(
    (repositoryFullName) =>
      repositoryFullName.toLowerCase() ===
      targetRepositoryFullName.toLowerCase(),
  );

  if (!includesTargetRepository) {
    return {
      workspace: null,
      failureReason: `I couldn't start this suggestion because its environment no longer includes \`${targetRepositoryFullName}\`.`,
    };
  }

  return {
    workspace: {
      repoForPayload: targetRepositoryFullName,
      environmentId: environment.id,
      workspaceDisplayName: environment.name,
      readinessMessage,
    },
    failureReason: null,
  };
}

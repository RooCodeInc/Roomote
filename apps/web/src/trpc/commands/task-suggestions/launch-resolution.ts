import { findEnvironmentForRepo } from '@roomote/cloud-agents/server';
import {
  asc,
  db,
  environments,
  inArray,
  repositories,
} from '@roomote/db/server';
import type { EnvironmentConfig } from '@roomote/types';

import type { PersistedTaskSuggestion } from './types';

type SuggestionLaunchCandidate = Pick<
  PersistedTaskSuggestion,
  | 'repositoryIds'
  | 'targetEnvironmentId'
  | 'targetRepositoryFullName'
  | 'readinessMessage'
>;

type RepositoryRow = {
  id: string;
  fullName: string;
  isActive: boolean;
};

type EnvironmentRow = {
  id: string;
  config: unknown;
  createdAt: Date;
  isEval: boolean;
};

type SuggestionResolutionContext = {
  repositoriesById: Map<string, RepositoryRow>;
  repositoriesByFullName: Map<string, RepositoryRow>;
  environments: EnvironmentRow[];
  environmentsById: Map<string, EnvironmentRow>;
};

function environmentIncludesRepositorySet(
  config: EnvironmentConfig,
  repositoryFullNames: string[],
): boolean {
  if (repositoryFullNames.length === 0) {
    return false;
  }

  const configuredRepositories = new Set(
    (config.repositories ?? []).map((repository) =>
      repository.repository.toLowerCase(),
    ),
  );

  return repositoryFullNames.every((repositoryFullName) =>
    configuredRepositories.has(repositoryFullName.toLowerCase()),
  );
}

function getConfiguredRepositoryFullNames(config: unknown): string[] {
  if (
    !config ||
    typeof config !== 'object' ||
    !('repositories' in config) ||
    !Array.isArray(config.repositories)
  ) {
    return [];
  }

  return config.repositories
    .map((repository) => repository?.repository)
    .filter(
      (repositoryFullName): repositoryFullName is string =>
        typeof repositoryFullName === 'string' && repositoryFullName.length > 0,
    );
}

async function buildSuggestionResolutionContext(
  suggestions: SuggestionLaunchCandidate[],
): Promise<SuggestionResolutionContext> {
  const repositoryIds = [
    ...new Set(suggestions.flatMap((suggestion) => suggestion.repositoryIds)),
  ];
  const targetRepositoryFullNames = [
    ...new Set(
      suggestions
        .map(
          (suggestion) => suggestion.targetRepositoryFullName?.trim() ?? null,
        )
        .filter((repositoryFullName): repositoryFullName is string =>
          Boolean(repositoryFullName),
        ),
    ),
  ];

  const [repositoryRows, targetRepositoryRows, environmentRows] =
    await Promise.all([
      repositoryIds.length === 0
        ? Promise.resolve([] as RepositoryRow[])
        : db
            .select({
              id: repositories.id,
              fullName: repositories.fullName,
              isActive: repositories.isActive,
            })
            .from(repositories)
            .where(inArray(repositories.id, repositoryIds)),
      targetRepositoryFullNames.length === 0
        ? Promise.resolve([] as RepositoryRow[])
        : db
            .select({
              id: repositories.id,
              fullName: repositories.fullName,
              isActive: repositories.isActive,
            })
            .from(repositories)
            .where(inArray(repositories.fullName, targetRepositoryFullNames)),
      db
        .select({
          id: environments.id,
          config: environments.config,
          createdAt: environments.createdAt,
          isEval: environments.isEval,
        })
        .from(environments)
        .orderBy(asc(environments.createdAt)),
    ]);

  const allRepositoryRows = [...repositoryRows, ...targetRepositoryRows];

  return {
    repositoriesById: new Map(
      allRepositoryRows.map((repository) => [repository.id, repository]),
    ),
    repositoriesByFullName: new Map(
      allRepositoryRows.map((repository) => [
        repository.fullName.toLowerCase(),
        repository,
      ]),
    ),
    environments: environmentRows,
    environmentsById: new Map(
      environmentRows.map((environment) => [environment.id, environment]),
    ),
  };
}

function resolveTargetRepository(
  suggestion: SuggestionLaunchCandidate,
  context: SuggestionResolutionContext,
): { repositoryFullName: string } | { failureReason: string } | null {
  const directTargetRepositoryFullName =
    suggestion.targetRepositoryFullName?.trim() ?? null;

  if (directTargetRepositoryFullName) {
    const repositoryTarget = context.repositoriesByFullName.get(
      directTargetRepositoryFullName.toLowerCase(),
    );

    if (!repositoryTarget || !repositoryTarget.isActive) {
      return {
        failureReason: `I couldn't start this suggestion because \`${directTargetRepositoryFullName}\` is no longer an active repository in this org.`,
      };
    }

    return {
      repositoryFullName: repositoryTarget.fullName,
    };
  }

  if (suggestion.repositoryIds.length !== 1) {
    return null;
  }

  const legacyRepositoryTarget = context.repositoriesById.get(
    suggestion.repositoryIds[0]!,
  );

  if (!legacyRepositoryTarget || !legacyRepositoryTarget.isActive) {
    return {
      failureReason:
        "I couldn't start this suggestion because its saved repository target is no longer active.",
    };
  }

  return {
    repositoryFullName: legacyRepositoryTarget.fullName,
  };
}

async function resolveSuggestionEnvironmentId(params: {
  suggestion: SuggestionLaunchCandidate;
  context: SuggestionResolutionContext;
  targetRepositoryFullName: string | null;
}): Promise<string | null> {
  const { suggestion, context, targetRepositoryFullName } = params;

  if (suggestion.targetEnvironmentId && targetRepositoryFullName) {
    const environment = context.environmentsById.get(
      suggestion.targetEnvironmentId,
    );

    const includesTargetRepository = getConfiguredRepositoryFullNames(
      environment?.config,
    ).some(
      (repositoryFullName) =>
        repositoryFullName.toLowerCase() ===
        targetRepositoryFullName.toLowerCase(),
    );

    if (environment && includesTargetRepository) {
      return environment.id;
    }
  }

  if (targetRepositoryFullName) {
    return (await findEnvironmentForRepo(targetRepositoryFullName)) ?? null;
  }

  const repositoryFullNames = suggestion.repositoryIds
    .map((repositoryId) => context.repositoriesById.get(repositoryId)?.fullName)
    .filter((repositoryFullName): repositoryFullName is string =>
      Boolean(repositoryFullName),
    );

  if (repositoryFullNames.length !== suggestion.repositoryIds.length) {
    return null;
  }

  const matchingEnvironment = context.environments
    .filter((environment) => !environment.isEval)
    .find((environment) =>
      environmentIncludesRepositorySet(
        environment.config as EnvironmentConfig,
        repositoryFullNames,
      ),
    );

  return matchingEnvironment?.id ?? null;
}

export async function decorateSuggestionsWithEnvironmentIds(
  suggestions: PersistedTaskSuggestion[],
) {
  if (suggestions.length === 0) {
    return [];
  }

  const context = await buildSuggestionResolutionContext(suggestions);

  return Promise.all(
    suggestions.map(async (suggestion) => {
      const targetRepository = resolveTargetRepository(suggestion, context);
      const targetRepositoryFullName =
        targetRepository && !('failureReason' in targetRepository)
          ? targetRepository.repositoryFullName
          : null;
      const environmentId = await resolveSuggestionEnvironmentId({
        suggestion,
        context,
        targetRepositoryFullName,
      });

      return {
        id: suggestion.id,
        title: suggestion.title,
        brief: suggestion.brief,
        environmentId,
      };
    }),
  );
}

import {
  getAvailableEnvironments,
  type RoutableEnvironment,
} from './available-environments';

export type RepositoryCoverage = {
  repositoryId?: string;
  repositoryFullName: string;
  targetEnvironmentId?: string;
};

export type RepositoryCoverageInput = {
  repositoryId: string;
  repositoryFullName: string;
};

type RepositoryCoverageWithIdentity = RepositoryCoverage & {
  repositoryId: string;
};

export async function buildRepositoryCoverage(
  repositories: RepositoryCoverageInput[],
): Promise<RepositoryCoverageWithIdentity[]> {
  const environments = await getAvailableEnvironments();

  return repositories.map(({ repositoryId, repositoryFullName }) => {
    const normalizedRepositoryName = repositoryFullName.toLowerCase();
    const matches = environments
      .filter((environment) =>
        environment.repositories?.some(
          (repository) => repository.id === repositoryId,
        ),
      )
      .sort((left, right) =>
        compareEnvironmentCoverage(left, right, normalizedRepositoryName),
      );
    const targetEnvironmentId = matches[0]?.id;

    return targetEnvironmentId
      ? {
          repositoryId,
          repositoryFullName,
          targetEnvironmentId,
        }
      : {
          repositoryId,
          repositoryFullName,
        };
  });
}

function compareEnvironmentCoverage(
  left: RoutableEnvironment,
  right: RoutableEnvironment,
  normalizedRepositoryName: string,
): number {
  const isPrimary = (environment: RoutableEnvironment) =>
    environment.config?.repositories[0]?.repository.toLowerCase() ===
    normalizedRepositoryName;
  const primaryDifference = Number(isPrimary(right)) - Number(isPrimary(left));

  return (
    primaryDifference ||
    left.repositoryNames.length - right.repositoryNames.length ||
    left.id.localeCompare(right.id)
  );
}

export function getEnvironmentBackedCoverage<T extends RepositoryCoverage>(
  repositoryCoverage: T[],
): Array<T & { targetEnvironmentId: string }> {
  return repositoryCoverage
    .filter((coverage): coverage is T & { targetEnvironmentId: string } =>
      Boolean(coverage.targetEnvironmentId),
    )
    .sort((left, right) =>
      left.repositoryFullName.localeCompare(right.repositoryFullName),
    );
}

export function formatRepositoryEnvironmentLines(
  repositoryCoverage: RepositoryCoverage[],
): string {
  return getEnvironmentBackedCoverage(repositoryCoverage)
    .map(
      (coverage) =>
        `- ${coverage.repositoryFullName} -> environment ${coverage.targetEnvironmentId}`,
    )
    .join('\n');
}

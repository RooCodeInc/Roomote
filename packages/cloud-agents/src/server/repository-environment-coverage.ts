import {
  getAvailableEnvironments,
  type RoutableEnvironment,
} from './available-environments';

export type RepositoryCoverage = {
  repositoryFullName: string;
  targetEnvironmentId?: string;
};

export type RepositoryCoverageInput = {
  repositoryId: string;
  repositoryFullName: string;
};

type EnvironmentBackedRepositoryCoverage = RepositoryCoverage & {
  targetEnvironmentId: string;
};

export async function buildRepositoryCoverage(
  repositories: RepositoryCoverageInput[],
): Promise<RepositoryCoverage[]> {
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
          repositoryFullName,
          targetEnvironmentId,
        }
      : {
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

export function getEnvironmentBackedCoverage(
  repositoryCoverage: RepositoryCoverage[],
): EnvironmentBackedRepositoryCoverage[] {
  return repositoryCoverage
    .filter((coverage): coverage is EnvironmentBackedRepositoryCoverage =>
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

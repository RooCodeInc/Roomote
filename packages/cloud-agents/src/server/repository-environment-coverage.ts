import { findEnvironmentForRepo } from './cloud-job-queue';

export type RepositoryCoverage = {
  repositoryFullName: string;
  targetEnvironmentId?: string;
};

type EnvironmentBackedRepositoryCoverage = RepositoryCoverage & {
  targetEnvironmentId: string;
};

export async function buildRepositoryCoverage(
  repositoryFullNames: string[],
): Promise<RepositoryCoverage[]> {
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

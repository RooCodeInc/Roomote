import type { SourceControlProvider } from '@roomote/types';
import { db, resolveWorkspaceRepositoryProviders } from '@roomote/db/server';

/**
 * Resolve the primary provider for an explicitly selected repository set.
 * Mixed-provider sets are supported; the queue stamps the complete provider
 * map before persistence.
 */
export function resolveSelectedRepositorySourceControlProvider(
  repositories: Array<{
    fullName: string;
    sourceControlProvider: SourceControlProvider;
  }>,
  repositoryOrder: string[],
): SourceControlProvider | undefined {
  for (const repositoryFullName of repositoryOrder) {
    const matches = repositories.filter(
      (repository) => repository.fullName === repositoryFullName,
    );

    if (matches.length > 1) {
      throw new Error(
        `Could not unambiguously resolve source control for: ${repositoryFullName}`,
      );
    }

    if (matches[0]) {
      return matches[0].sourceControlProvider;
    }
  }

  return undefined;
}

/**
 * Resolve the provider for an environment-backed launch by delegating to the
 * shared resolver (single source of truth for the environment-repository join).
 *
 * Mixed environments use their first repository's provider as the scalar
 * compatibility value. Queue stamping adds the complete repository map.
 */
export async function resolveEnvironmentSourceControlProvider(
  environmentId: string | undefined,
): Promise<SourceControlProvider | undefined> {
  if (!environmentId) {
    return undefined;
  }

  const repositoryProviders = await resolveWorkspaceRepositoryProviders(db, {
    type: 'environment',
    environmentId,
  });
  return Object.values(repositoryProviders)[0];
}

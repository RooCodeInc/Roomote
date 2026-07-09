import type { SourceControlProvider } from '@roomote/types';
import {
  and,
  db,
  environmentRepositoryMappings,
  eq,
  repositories,
} from '@roomote/db/server';

/**
 * Resolve the single provider a launch's repositories belong to, so the task
 * payload can carry an explicit `sourceControlProvider`. Without it, dequeue
 * falls back to the GitHub default and non-GitHub deployments fail source
 * control token creation.
 */
export function resolveSingleSourceControlProvider(
  providers: SourceControlProvider[],
): SourceControlProvider | undefined {
  const uniqueProviders = [...new Set(providers)];

  if (uniqueProviders.length > 1) {
    throw new Error(
      'Selected repositories must belong to a single source control provider.',
    );
  }

  return uniqueProviders[0];
}

export async function resolveEnvironmentSourceControlProvider(
  environmentId: string | undefined,
): Promise<SourceControlProvider | undefined> {
  if (!environmentId) {
    return undefined;
  }

  const rows = await db
    .select({
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(environmentRepositoryMappings)
    .innerJoin(
      repositories,
      eq(environmentRepositoryMappings.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(environmentRepositoryMappings.environmentId, environmentId),
        eq(repositories.isActive, true),
      ),
    );

  return resolveSingleSourceControlProvider(
    rows.map((row) => row.sourceControlProvider),
  );
}

import type { SourceControlProvider } from '@roomote/types';
import { db, resolveWorkspaceRepositoryProviders } from '@roomote/db/server';

/**
 * Resolve the single provider a launch's explicitly selected repositories
 * belong to, so the task payload can carry an explicit `sourceControlProvider`.
 * Without it, dequeue falls back to the GitHub default and non-GitHub
 * deployments fail source control token creation.
 *
 * This is the web launch-validation path: it THROWS when the selection spans
 * multiple providers, surfacing a clear error before enqueue. This differs from
 * the shared {@link resolveWorkspaceSourceControlProvider}, which returns
 * `undefined` on ambiguity and defers to the downstream GitHub fallback.
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

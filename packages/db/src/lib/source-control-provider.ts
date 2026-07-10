import { and, eq, inArray } from 'drizzle-orm';
import type { TaskWorkspace, SourceControlProvider } from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import { environmentRepositoryMappings, repositories } from '../schema';

/**
 * Collapse a set of repository providers to the single provider they all
 * share, or `undefined` when the set is empty or spans multiple providers.
 * `undefined` means "ambiguous or none" — callers treat it as "leave the
 * provider unstamped and fall back downstream", never as an error.
 */
function toSingleProvider(
  providers: SourceControlProvider[],
): SourceControlProvider | undefined {
  const unique = [...new Set(providers)];
  return unique.length === 1 ? unique[0] : undefined;
}

async function resolveProviderByFullNames(
  dbOrTx: DatabaseOrTransaction,
  fullNames: string[],
): Promise<SourceControlProvider | undefined> {
  if (fullNames.length === 0) {
    return undefined;
  }

  const rows = await dbOrTx
    .select({ sourceControlProvider: repositories.sourceControlProvider })
    .from(repositories)
    .where(inArray(repositories.fullName, fullNames));

  return toSingleProvider(rows.map((row) => row.sourceControlProvider));
}

async function resolveEnvironmentProvider(
  dbOrTx: DatabaseOrTransaction,
  environmentId: string,
): Promise<SourceControlProvider | undefined> {
  const rows = await dbOrTx
    .select({ sourceControlProvider: repositories.sourceControlProvider })
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

  return toSingleProvider(rows.map((row) => row.sourceControlProvider));
}

async function resolveAllRepositoriesProvider(
  dbOrTx: DatabaseOrTransaction,
): Promise<SourceControlProvider | undefined> {
  const rows = await dbOrTx
    .select({ sourceControlProvider: repositories.sourceControlProvider })
    .from(repositories)
    .where(eq(repositories.isActive, true));

  return toSingleProvider(rows.map((row) => row.sourceControlProvider));
}

/**
 * Resolve the single source-control provider a launch's workspace belongs to,
 * so the task payload can carry an explicit `sourceControlProvider`. Handles
 * every workspace shape (single repo, repo set, environment, all repositories).
 *
 * Returns `undefined` when the provider is ambiguous (spans multiple providers)
 * or unknown (no matching repositories). This never throws — an unresolved
 * provider means the caller should leave the payload unstamped and let the
 * downstream GitHub default apply. The web launch-validation path wraps this
 * resolver to add its own throw-on-multi-provider behavior.
 */
export async function resolveWorkspaceSourceControlProvider(
  dbOrTx: DatabaseOrTransaction,
  workspace: TaskWorkspace,
): Promise<SourceControlProvider | undefined> {
  switch (workspace.type) {
    case 'repository':
      return resolveProviderByFullNames(dbOrTx, [workspace.repo]);
    case 'repository_set':
      return resolveProviderByFullNames(dbOrTx, workspace.repositories);
    case 'environment':
      return resolveEnvironmentProvider(dbOrTx, workspace.environmentId);
    case 'all_repositories':
      return resolveAllRepositoriesProvider(dbOrTx);
  }
}

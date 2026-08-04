import { and, asc, eq, inArray } from 'drizzle-orm';
import type { TaskWorkspace, SourceControlProvider } from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import {
  environmentRepositoryMappings,
  environments,
  repositories,
} from '../schema';

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

type RepositoryProviderRow = {
  fullName: string;
  host: string | null;
  sourceControlProvider: SourceControlProvider;
};

function toRepositoryProviderMap(
  rows: RepositoryProviderRow[],
  repositoryOrder: string[],
  sourceControlHost?: string,
): Record<string, SourceControlProvider> {
  const rowsByFullName = new Map<string, RepositoryProviderRow[]>();

  for (const row of rows) {
    const matches = rowsByFullName.get(row.fullName) ?? [];
    matches.push(row);
    rowsByFullName.set(row.fullName, matches);
  }

  const result: Record<string, SourceControlProvider> = {};

  for (const fullName of [...new Set(repositoryOrder)]) {
    const matches = rowsByFullName.get(fullName) ?? [];
    const hostMatches =
      matches.length > 1 && sourceControlHost
        ? matches.filter((row) => row.host === sourceControlHost)
        : matches;

    if (matches.length > 1 && hostMatches.length !== 1) {
      console.warn(
        `[resolveWorkspaceRepositoryProviders] Omitting ambiguous repository ${fullName}; matched ${matches.length} rows.`,
      );
      continue;
    }

    const match = hostMatches[0];
    if (match) {
      result[fullName] = match.sourceControlProvider;
    }
  }

  return result;
}

async function resolveProvidersByFullNames(
  dbOrTx: DatabaseOrTransaction,
  fullNames: string[],
  sourceControlHost?: string,
): Promise<Record<string, SourceControlProvider>> {
  if (fullNames.length === 0) {
    return {};
  }

  const rows = await dbOrTx
    .select({
      fullName: repositories.fullName,
      host: repositories.host,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .where(inArray(repositories.fullName, fullNames));

  return toRepositoryProviderMap(rows, fullNames, sourceControlHost);
}

async function resolveEnvironmentProviders(
  dbOrTx: DatabaseOrTransaction,
  environmentId: string,
): Promise<Record<string, SourceControlProvider>> {
  const environment = await dbOrTx.query.environments.findFirst({
    where: eq(environments.id, environmentId),
    columns: { config: true },
  });

  if (!environment) {
    return {};
  }

  const rows = await dbOrTx
    .select({
      fullName: repositories.fullName,
      host: repositories.host,
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
    )
    .orderBy(
      asc(environmentRepositoryMappings.createdAt),
      asc(environmentRepositoryMappings.id),
    );

  return toRepositoryProviderMap(
    rows,
    environment.config.repositories.map((repository) => repository.repository),
  );
}

async function resolveAllRepositoriesProviders(
  dbOrTx: DatabaseOrTransaction,
): Promise<Record<string, SourceControlProvider>> {
  const rows = await dbOrTx
    .select({
      fullName: repositories.fullName,
      host: repositories.host,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .where(eq(repositories.isActive, true))
    .orderBy(asc(repositories.createdAt), asc(repositories.id));

  return toRepositoryProviderMap(
    rows,
    rows.map((row) => row.fullName),
  );
}

/** Resolve repository full names to providers in workspace order. */
export async function resolveWorkspaceRepositoryProviders(
  dbOrTx: DatabaseOrTransaction,
  workspace: TaskWorkspace,
): Promise<Record<string, SourceControlProvider>> {
  switch (workspace.type) {
    case 'repository':
      return resolveProvidersByFullNames(
        dbOrTx,
        [workspace.repo],
        workspace.sourceControlHost,
      );
    case 'repository_set':
      return resolveProvidersByFullNames(
        dbOrTx,
        workspace.repositories,
        workspace.sourceControlHost,
      );
    case 'environment':
      return resolveEnvironmentProviders(dbOrTx, workspace.environmentId);
    case 'all_repositories':
      return resolveAllRepositoriesProviders(dbOrTx);
  }
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
  const repositoryProviders = await resolveWorkspaceRepositoryProviders(
    dbOrTx,
    workspace,
  );
  return toSingleProvider(Object.values(repositoryProviders));
}

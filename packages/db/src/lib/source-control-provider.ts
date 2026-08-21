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
  isActive?: boolean;
  private?: boolean;
  sourceControlProvider: SourceControlProvider;
};

export type RepositorySourceControl = {
  provider: SourceControlProvider;
  host?: string;
};

function selectRepositoryRows(
  rows: RepositoryProviderRow[],
  repositoryOrder: string[],
  sourceControlHost?: string,
): RepositoryProviderRow[] | null {
  const rowsByFullName = new Map<string, RepositoryProviderRow[]>();

  for (const row of rows) {
    const matches = rowsByFullName.get(row.fullName) ?? [];
    matches.push(row);
    rowsByFullName.set(row.fullName, matches);
  }

  const selected: RepositoryProviderRow[] = [];

  for (const fullName of [...new Set(repositoryOrder)]) {
    const matches = rowsByFullName.get(fullName) ?? [];
    const activeMatches = matches.filter((row) => row.isActive === true);
    const candidates = activeMatches.length > 0 ? activeMatches : matches;
    const hostMatches = sourceControlHost
      ? candidates.filter((row) => row.host === sourceControlHost)
      : candidates;

    if (hostMatches.length !== 1) {
      return null;
    }

    selected.push(hostMatches[0]!);
  }

  return selected.length > 0 ? selected : null;
}

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
    const activeMatches = matches.filter((row) => row.isActive === true);
    const candidates = activeMatches.length > 0 ? activeMatches : matches;
    const hostMatches = sourceControlHost
      ? candidates.filter((row) => row.host === sourceControlHost)
      : candidates;

    if (candidates.length > 1 && hostMatches.length !== 1) {
      console.warn(
        `[resolveWorkspaceRepositoryProviders] Omitting ambiguous repository ${fullName}; matched ${candidates.length} candidate rows.`,
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
      isActive: repositories.isActive,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .where(inArray(repositories.fullName, fullNames));

  return toRepositoryProviderMap(rows, fullNames, sourceControlHost);
}

/** Resolve the provider and host for one exact repository, or fail closed. */
export async function resolveRepositorySourceControl(
  dbOrTx: DatabaseOrTransaction,
  fullName: string,
  sourceControlHost?: string,
): Promise<RepositorySourceControl | undefined> {
  const rows = await dbOrTx
    .select({
      fullName: repositories.fullName,
      host: repositories.host,
      isActive: repositories.isActive,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .where(eq(repositories.fullName, fullName));
  const selected = selectRepositoryRows(rows, [fullName], sourceControlHost);
  const repository = selected?.[0];

  return repository
    ? {
        provider: repository.sourceControlProvider,
        ...(repository.host ? { host: repository.host } : {}),
      }
    : undefined;
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
      isActive: repositories.isActive,
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
      isActive: repositories.isActive,
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

async function resolveWorkspaceRepositoryRows(
  dbOrTx: DatabaseOrTransaction,
  workspace: TaskWorkspace,
): Promise<RepositoryProviderRow[] | null> {
  if (workspace.type === 'environment') {
    const environment = await dbOrTx.query.environments.findFirst({
      where: eq(environments.id, workspace.environmentId),
      columns: { config: true },
    });
    if (!environment) {
      return null;
    }

    const rows = await dbOrTx
      .select({
        fullName: repositories.fullName,
        host: repositories.host,
        isActive: repositories.isActive,
        private: repositories.private,
        sourceControlProvider: repositories.sourceControlProvider,
      })
      .from(environmentRepositoryMappings)
      .innerJoin(
        repositories,
        eq(environmentRepositoryMappings.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(
            environmentRepositoryMappings.environmentId,
            workspace.environmentId,
          ),
          eq(repositories.isActive, true),
        ),
      );
    const selected = selectRepositoryRows(
      rows,
      environment.config.repositories.map(
        (repository) => repository.repository,
      ),
    );
    return selected;
  }

  if (workspace.type === 'all_repositories') {
    const rows = await dbOrTx
      .select({
        fullName: repositories.fullName,
        host: repositories.host,
        isActive: repositories.isActive,
        private: repositories.private,
        sourceControlProvider: repositories.sourceControlProvider,
      })
      .from(repositories)
      .where(eq(repositories.isActive, true));
    return rows.length > 0 ? rows : null;
  }

  const fullNames =
    workspace.type === 'repository' ? [workspace.repo] : workspace.repositories;
  const rows = await dbOrTx
    .select({
      fullName: repositories.fullName,
      host: repositories.host,
      isActive: repositories.isActive,
      private: repositories.private,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .where(inArray(repositories.fullName, fullNames));
  const selected = selectRepositoryRows(
    rows,
    fullNames,
    workspace.sourceControlHost,
  );
  return selected;
}

/**
 * Whether every repository in a workspace is known private. Missing or
 * ambiguous repository rows return false so attribution fails toward privacy.
 */
export async function workspaceAllowsPrivateAttribution(
  dbOrTx: DatabaseOrTransaction,
  workspace: TaskWorkspace,
): Promise<boolean> {
  const rows = await resolveWorkspaceRepositoryRows(dbOrTx, workspace);
  return rows?.every((repository) => repository.private === true) ?? false;
}

/** Whether every known repository can use a handle from the same provider. */
export async function workspaceUsesOnlySourceControlProvider(
  dbOrTx: DatabaseOrTransaction,
  workspace: TaskWorkspace,
  provider: SourceControlProvider,
): Promise<boolean> {
  const rows = await resolveWorkspaceRepositoryRows(dbOrTx, workspace);
  return (
    rows?.every(
      (repository) => repository.sourceControlProvider === provider,
    ) ?? false
  );
}

/**
 * Resolve the single source-control provider a launch's workspace belongs to,
 * so the task payload can carry an explicit `sourceControlProvider`. Handles
 * every workspace shape (single repo, repo set, environment, all repositories).
 *
 * Returns `undefined` when the provider is ambiguous (spans multiple providers)
 * or unknown (no matching repositories). This never throws — callers that
 * require a resolved provider validate the returned repository map before
 * enqueue, while legacy callers may leave the scalar provider unstamped.
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

/** Resolve one exact repository host for attribution, or fail closed. */
export async function resolveWorkspaceSourceControlHost(
  dbOrTx: DatabaseOrTransaction,
  workspace: TaskWorkspace,
): Promise<string | undefined> {
  const rows = await resolveWorkspaceRepositoryRows(dbOrTx, workspace);
  if (!rows) {
    return undefined;
  }

  const hosts = [...new Set(rows.map((row) => row.host).filter(Boolean))];
  return hosts.length === 1 && rows.every((row) => row.host === hosts[0])
    ? (hosts[0] ?? undefined)
    : undefined;
}

import * as GitHub from '@roomote/github';
import type { SourceControlProvider } from '@roomote/types';
import {
  sourceControlProviderDescriptors,
  sourceControlTokenBackedProviders,
} from '@roomote/types';
import {
  db,
  repositories,
  githubInstallations,
  and,
  eq,
  inArray,
  isNull,
  or,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { authorizeOrThrow } from './auth-context';

type SourceControlConnectionSummary = {
  connectedProviders: SourceControlProvider[];
  repositoryCounts: Partial<Record<SourceControlProvider, number>>;
};

export async function getSourceControlConnectionSummary(): Promise<SourceControlConnectionSummary> {
  const rows = await db
    .select({
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .leftJoin(
      githubInstallations,
      eq(repositories.installationId, githubInstallations.id),
    )
    .where(
      and(eq(repositories.isActive, true), getConnectedRepositoryFilter()),
    );

  const repositoryCounts: Partial<Record<SourceControlProvider, number>> = {};
  for (const row of rows) {
    const provider = row.sourceControlProvider as SourceControlProvider;
    repositoryCounts[provider] = (repositoryCounts[provider] ?? 0) + 1;
  }

  const connectedProviders = (
    Object.keys(sourceControlProviderDescriptors) as SourceControlProvider[]
  ).filter((provider) => (repositoryCounts[provider] ?? 0) > 0);

  return {
    connectedProviders,
    repositoryCounts,
  };
}

type RepositoryRow = typeof repositories.$inferSelect;
type RepositoryWithEmptyState = RepositoryRow & { isEmpty: boolean };
type GetRepositoriesOptions = {
  includeEmptyState?: boolean;
  sourceControlProvider?: SourceControlProvider;
};

function getConnectedRepositoryFilter(provider?: SourceControlProvider) {
  const tokenBackedFilter = inArray(
    repositories.sourceControlProvider,
    sourceControlTokenBackedProviders,
  );
  const connectedGitHubFilter = and(
    eq(repositories.sourceControlProvider, 'github'),
    isNull(githubInstallations.suspendedAt),
  );

  if (provider === 'github') {
    return connectedGitHubFilter;
  }

  if (provider) {
    return eq(repositories.sourceControlProvider, provider);
  }

  return or(tokenBackedFilter, connectedGitHubFilter);
}

export async function getRepositories(
  authResult?: UserAuthSuccess,
): Promise<RepositoryRow[]>;
export async function getRepositories(
  authResult: UserAuthSuccess | undefined,
  options: GetRepositoriesOptions & { includeEmptyState: true },
): Promise<RepositoryWithEmptyState[]>;
export async function getRepositories(
  authResult: UserAuthSuccess | undefined,
  options?: GetRepositoriesOptions,
): Promise<RepositoryRow[]>;
export async function getRepositories(
  authResult?: UserAuthSuccess,
  options?: GetRepositoriesOptions,
): Promise<RepositoryRow[] | RepositoryWithEmptyState[]> {
  authResult ??= await authorizeOrThrow();

  const repos = await db
    .select({ repo: repositories })
    .from(repositories)
    .leftJoin(
      githubInstallations,
      eq(repositories.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(repositories.isActive, true),
        getConnectedRepositoryFilter(options?.sourceControlProvider),
      ),
    );

  const activeRepositories = repos
    .map(({ repo }) => repo)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  if (!options?.includeEmptyState || activeRepositories.length === 0) {
    return activeRepositories;
  }

  const gitHubRepositoryIds = activeRepositories
    .filter((repository) => repository.sourceControlProvider === 'github')
    .map((repository) => repository.id);
  const emptyStates =
    gitHubRepositoryIds.length > 0
      ? await GitHub.getRepositoryEmptyStates({
          repositoryIds: gitHubRepositoryIds,
        })
      : new Map<string, boolean>();

  return activeRepositories.map((repository) => ({
    ...repository,
    isEmpty: emptyStates.get(repository.id) ?? false,
  }));
}

/**
 * Check whether the deployment has access to a repository by its full name
 * (owner/repo). GitHub repositories require a non-suspended installation;
 * token-backed providers only require an active repository row.
 */
export async function checkRepoAccess(repoFullName: string): Promise<boolean> {
  const match = await db
    .select({ id: repositories.id })
    .from(repositories)
    .leftJoin(
      githubInstallations,
      eq(repositories.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(repositories.fullName, repoFullName),
        eq(repositories.isActive, true),
        getConnectedRepositoryFilter(),
      ),
    )
    .limit(1);

  return match.length > 0;
}

/**
 * Check whether the current user has access to a repository by its full name
 * (owner/repo). Returns true only when the repo is active, belongs to this
 * deployment, and its source-control connection is active.
 */
export async function hasRepoAccess(
  fullName: string,
  authResult?: UserAuthSuccess,
): Promise<boolean> {
  authResult ??= await authorizeOrThrow();
  return checkRepoAccess(fullName);
}

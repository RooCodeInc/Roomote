import {
  and,
  db,
  eq,
  githubInstallations,
  inArray,
  isNull,
  repositories,
} from '@roomote/db/server';
import type { SourceControlProvider } from '@roomote/types';

export async function hasActiveGitHubInstallation(): Promise<boolean> {
  const [installation] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(isNull(githubInstallations.suspendedAt))
    .limit(1);

  return Boolean(installation);
}

/**
 * Provider-agnostic repository gate. Suggestion scans work with any synced
 * active repository (GitHub, GitLab, Gitea, ADO), so eligibility must not
 * require a GitHub App installation specifically.
 */
export async function hasAnyActiveRepository(): Promise<boolean> {
  const [row] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.isActive, true))
    .limit(1);

  return Boolean(row);
}

export async function getActiveRepositoryFullNames(): Promise<string[]> {
  const rows = await db
    .select({
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(eq(repositories.isActive, true))
    .orderBy(repositories.fullName);

  return [...new Set(rows.map((row) => row.fullName).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

export async function getActiveGitHubRepositoryFullNames(): Promise<string[]> {
  const rows = await db
    .select({
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.isActive, true),
        eq(repositories.sourceControlProvider, 'github'),
      ),
    )
    .orderBy(repositories.fullName);

  return [...new Set(rows.map((row) => row.fullName).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

type ActiveRepositoryRef = {
  fullName: string;
  sourceControlProvider: SourceControlProvider;
  externalRepoId: string | null;
  host: string | null;
  defaultBranch: string;
};

/**
 * Active repositories limited to the given source-control providers.
 */
export async function getActiveRepositoriesForProviders(
  providers: readonly SourceControlProvider[],
): Promise<ActiveRepositoryRef[]> {
  if (providers.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
      externalRepoId: repositories.externalRepoId,
      host: repositories.host,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.isActive, true),
        inArray(repositories.sourceControlProvider, [...providers]),
      ),
    )
    .orderBy(repositories.fullName);

  const seen = new Set<string>();
  const result: ActiveRepositoryRef[] = [];
  for (const row of rows) {
    if (!row.fullName || seen.has(row.fullName)) {
      continue;
    }
    seen.add(row.fullName);
    result.push({
      fullName: row.fullName,
      sourceControlProvider: row.sourceControlProvider as SourceControlProvider,
      externalRepoId: row.externalRepoId,
      host: row.host,
      defaultBranch: row.defaultBranch,
    });
  }
  return result;
}

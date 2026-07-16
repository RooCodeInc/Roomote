import {
  and,
  db,
  eq,
  githubInstallations,
  isNull,
  repositories,
} from '@roomote/db/server';

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

import {
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

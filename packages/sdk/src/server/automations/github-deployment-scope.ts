import {
  and,
  db,
  environmentRepositoryMappings,
  environments,
  eq,
  githubInstallations,
  inArray,
  isNull,
  repositories,
  sql,
} from '@roomote/db/server';
import {
  sourceControlProviders,
  type SourceControlProvider,
} from '@roomote/types';

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

export type ActiveRepositoryProviderPartition = {
  provider: SourceControlProvider;
  host: string | null;
  repositoryFullNames: string[];
};

/**
 * Group active repositories into per-(provider, host) partitions so scan
 * launchers can keep every launched run single-provider: a run's
 * source-control token is minted for exactly one provider, and a scope that
 * spans providers otherwise falls back to the GitHub default and fails token
 * creation on the non-GitHub repositories. Partition order is deterministic:
 * the provider enum order, then host lexicographically. Names that no longer
 * match an active repository are dropped.
 */
export async function partitionActiveRepositoriesByProvider(
  repositoryFullNames: string[],
): Promise<ActiveRepositoryProviderPartition[]> {
  if (repositoryFullNames.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
      host: repositories.host,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.isActive, true),
        inArray(repositories.fullName, repositoryFullNames),
      ),
    )
    .orderBy(repositories.fullName);

  const partitions = new Map<string, ActiveRepositoryProviderPartition>();

  for (const row of rows) {
    if (!row.fullName) {
      continue;
    }

    const partitionKey = `${row.sourceControlProvider}\u0000${row.host ?? ''}`;
    const partition = partitions.get(partitionKey);

    if (!partition) {
      partitions.set(partitionKey, {
        provider: row.sourceControlProvider as SourceControlProvider,
        host: row.host,
        repositoryFullNames: [row.fullName],
      });
    } else if (!partition.repositoryFullNames.includes(row.fullName)) {
      partition.repositoryFullNames.push(row.fullName);
    }
  }

  return sourceControlProviders.flatMap((provider) =>
    [...partitions.values()]
      .filter((partition) => partition.provider === provider)
      .sort((left, right) => (left.host ?? '').localeCompare(right.host ?? '')),
  );
}

type ActiveRepositoryRef = {
  id: string;
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
      id: repositories.id,
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
    if (!row.fullName) {
      continue;
    }
    // Identity is provider + host + fullName; do not collapse same-path
    // projects on different instances before Manual Run now inspects them.
    const identityKey = [
      row.sourceControlProvider,
      row.host ?? '',
      row.fullName,
    ].join('\0');
    if (seen.has(identityKey)) {
      continue;
    }
    seen.add(identityKey);
    result.push({
      id: row.id,
      fullName: row.fullName,
      sourceControlProvider: row.sourceControlProvider as SourceControlProvider,
      externalRepoId: row.externalRepoId,
      host: row.host,
      defaultBranch: row.defaultBranch,
    });
  }
  return result;
}

/**
 * Resolve the environment mapped to a specific repository row (provider+host
 * scoped). Eval environments are excluded (same as findEnvironmentForRepo).
 * When multiple non-eval environments map the same repository, prefer the
 * most specific mapping (fewest repositories), then a stable environment id.
 */
export async function findEnvironmentIdForRepositoryId(
  repositoryId: string,
): Promise<string | undefined> {
  const directMappings = await db
    .select({
      environmentId: environmentRepositoryMappings.environmentId,
    })
    .from(environmentRepositoryMappings)
    .innerJoin(
      environments,
      eq(environments.id, environmentRepositoryMappings.environmentId),
    )
    .where(
      and(
        eq(environmentRepositoryMappings.repositoryId, repositoryId),
        eq(environments.isEval, false),
      ),
    );

  if (directMappings.length === 0) {
    return undefined;
  }

  if (directMappings.length === 1) {
    return directMappings[0]!.environmentId;
  }

  const environmentIds = [
    ...new Set(directMappings.map((row) => row.environmentId)),
  ];
  const counts = await db
    .select({
      environmentId: environmentRepositoryMappings.environmentId,
      repoCount: sql<number>`count(*)::int`,
    })
    .from(environmentRepositoryMappings)
    .innerJoin(
      environments,
      eq(environments.id, environmentRepositoryMappings.environmentId),
    )
    .where(
      and(
        inArray(environmentRepositoryMappings.environmentId, environmentIds),
        eq(environments.isEval, false),
      ),
    )
    .groupBy(environmentRepositoryMappings.environmentId);

  counts.sort(
    (left, right) =>
      left.repoCount - right.repoCount ||
      left.environmentId.localeCompare(right.environmentId),
  );

  return counts[0]?.environmentId;
}

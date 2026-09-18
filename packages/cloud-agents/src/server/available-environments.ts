import {
  and,
  db,
  environmentRepositoryMappings,
  environments,
  eq,
  isNull,
  repositories,
} from '@roomote/db/server';

/** An environment the Fast Session can delegate a task to. */
export interface RoutableEnvironment {
  id: string;
  name: string;
  description?: string;
  repositories?: Array<{ id: string; name: string }>;
  repositoryNames: string[];
}

/** Active repository names the Fast Session can show, independent of environments. */
export interface ActiveRepositoryCatalog {
  /** Sorted full names, capped to keep the prompt bounded. Names shared across
   * providers or hosts are listed once each, qualified with both. */
  names: string[];
  /** Every active repository, including the ones omitted from `names`. */
  totalCount: number;
}

/** Keeps the Fast prompt bounded on deployments with many connected repositories. */
const ACTIVE_REPOSITORY_PROMPT_LIMIT = 200;

interface ActiveRepositoryRow {
  fullName: string;
  sourceControlProvider: string;
  host: string | null;
}

/**
 * `fullName` is only unique per (provider, host): the same owner/repo can be
 * connected from two providers or a self-managed host. Those entries stay
 * separate and carry their provider and host, so a name that matches both
 * reads as ambiguous instead of as a single match.
 */
export function buildActiveRepositoryCatalog(
  rows: ActiveRepositoryRow[],
  limit = ACTIVE_REPOSITORY_PROMPT_LIMIT,
): ActiveRepositoryCatalog {
  const identities = new Map<string, ActiveRepositoryRow>();
  for (const row of rows) {
    identities.set(
      [row.sourceControlProvider, row.host ?? '', row.fullName].join('\u0000'),
      row,
    );
  }

  const countsByFullName = new Map<string, number>();
  for (const { fullName } of identities.values()) {
    countsByFullName.set(fullName, (countsByFullName.get(fullName) ?? 0) + 1);
  }

  const names = [...identities.values()]
    .map((row) =>
      (countsByFullName.get(row.fullName) ?? 0) > 1
        ? `${row.fullName} (${[row.sourceControlProvider, row.host].filter(Boolean).join(', ')})`
        : row.fullName,
    )
    .sort((a, b) => a.localeCompare(b));

  return { names: names.slice(0, limit), totalCount: names.length };
}

/** Where a launch runs: one named environment, or every repository. */
export type RoutingWorkspace =
  | { type: 'environment'; id: string; name: string }
  | { type: 'all_repositories' };

/** Every shared, non-eval environment with the repositories it maps. */
export async function getAvailableEnvironments(): Promise<
  RoutableEnvironment[]
> {
  const envs = await db
    .select({
      id: environments.id,
      name: environments.name,
      description: environments.description,
    })
    .from(environments)
    .where(and(eq(environments.isEval, false), isNull(environments.userId)));

  // Get repository names for each environment.
  const result: RoutableEnvironment[] = [];

  for (const env of envs) {
    const mappings = await db
      .select({
        repoId: repositories.id,
        repoName: repositories.fullName,
      })
      .from(environmentRepositoryMappings)
      .innerJoin(
        repositories,
        eq(environmentRepositoryMappings.repositoryId, repositories.id),
      )
      .where(eq(environmentRepositoryMappings.environmentId, env.id));

    result.push({
      id: env.id,
      name: env.name,
      description: env.description ?? undefined,
      repositories: mappings.map((mapping) => ({
        id: mapping.repoId,
        name: mapping.repoName,
      })),
      repositoryNames: mappings.map((m) => m.repoName),
    });
  }

  return result;
}

/**
 * Every active connected repository, whether or not an environment maps it.
 * Tasks can check any of these out on demand, so the Fast Session needs the
 * names even on deployments with no environments configured.
 */
export async function getActiveRepositoryCatalog(): Promise<ActiveRepositoryCatalog> {
  const rows = await db
    .select({
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
      host: repositories.host,
    })
    .from(repositories)
    .where(eq(repositories.isActive, true));

  return buildActiveRepositoryCatalog(rows);
}

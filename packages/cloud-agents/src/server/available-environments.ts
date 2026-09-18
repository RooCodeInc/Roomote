import {
  and,
  asc,
  count,
  db,
  environmentRepositoryMappings,
  environments,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  repositories,
} from '@roomote/db/server';
import {
  FAST_AGENT_LIST_REPOSITORIES_DEFAULT_LIMIT,
  FAST_AGENT_LIST_REPOSITORIES_MAX_LIMIT,
} from '@roomote/types';

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

const LIST_REPOSITORIES_DESCRIPTION_LIMIT = 160;

/** One active connected repository as the Fast `list_repositories` tool reports it. */
interface ListedRepository {
  id: string;
  fullName: string;
  sourceControlProvider: string;
  host: string | null;
  defaultBranch: string;
  private: boolean;
  url: string;
  description?: string;
  /** Shared environments that map this repository; empty when none does. */
  environments: Array<{ id: string; name: string }>;
}

interface ListedRepositoriesPage {
  repositories: ListedRepository[];
  /** Active repositories matching the query, across every page. */
  totalCount: number;
  /** Present when more matches follow; pass it back as `offset`. */
  nextOffset?: number;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function truncateRepositoryDescription(description: string | null) {
  const singleLine = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!singleLine) return undefined;
  return singleLine.length <= LIST_REPOSITORIES_DESCRIPTION_LIMIT
    ? singleLine
    : `${singleLine.slice(0, LIST_REPOSITORIES_DESCRIPTION_LIMIT - 1).trimEnd()}…`;
}

/**
 * A page of active connected repositories, read live so a repository connected
 * mid-conversation is visible. Every whitespace-separated query term must
 * appear in the full name or the description, case-insensitively.
 */
export async function listActiveRepositories({
  query,
  offset = 0,
  limit = FAST_AGENT_LIST_REPOSITORIES_DEFAULT_LIMIT,
}: {
  query?: string;
  offset?: number;
  limit?: number;
} = {}): Promise<ListedRepositoriesPage> {
  const pageSize = Math.min(
    Math.max(limit, 1),
    FAST_AGENT_LIST_REPOSITORIES_MAX_LIMIT,
  );
  const terms = (query ?? '').split(/\s+/).filter(Boolean);
  const where = and(
    eq(repositories.isActive, true),
    ...terms.map((term) => {
      const pattern = `%${escapeLikePattern(term)}%`;
      return or(
        ilike(repositories.fullName, pattern),
        ilike(repositories.description, pattern),
      );
    }),
  );

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: repositories.id,
        fullName: repositories.fullName,
        sourceControlProvider: repositories.sourceControlProvider,
        host: repositories.host,
        defaultBranch: repositories.defaultBranch,
        private: repositories.private,
        url: repositories.htmlUrl,
        description: repositories.description,
      })
      .from(repositories)
      .where(where)
      .orderBy(
        asc(repositories.fullName),
        asc(repositories.sourceControlProvider),
        asc(repositories.id),
      )
      .limit(pageSize)
      .offset(offset),
    db.select({ value: count() }).from(repositories).where(where),
  ]);

  const environmentRows =
    rows.length === 0
      ? []
      : await db
          .select({
            repositoryId: environmentRepositoryMappings.repositoryId,
            id: environments.id,
            name: environments.name,
          })
          .from(environmentRepositoryMappings)
          .innerJoin(
            environments,
            eq(environmentRepositoryMappings.environmentId, environments.id),
          )
          .where(
            and(
              inArray(
                environmentRepositoryMappings.repositoryId,
                rows.map((row) => row.id),
              ),
              eq(environments.isEval, false),
              isNull(environments.userId),
            ),
          )
          .orderBy(asc(environments.name), asc(environments.id));

  const environmentsByRepository = new Map<
    string,
    ListedRepository['environments']
  >();
  for (const { repositoryId, id, name } of environmentRows) {
    const mapped = environmentsByRepository.get(repositoryId) ?? [];
    mapped.push({ id, name });
    environmentsByRepository.set(repositoryId, mapped);
  }

  const totalCount = total?.value ?? 0;
  const nextOffset = offset + rows.length;
  return {
    repositories: rows.map(({ description, ...row }) => {
      const summary = truncateRepositoryDescription(description);
      return {
        ...row,
        ...(summary ? { description: summary } : {}),
        environments: environmentsByRepository.get(row.id) ?? [],
      };
    }),
    totalCount,
    ...(rows.length > 0 && nextOffset < totalCount ? { nextOffset } : {}),
  };
}

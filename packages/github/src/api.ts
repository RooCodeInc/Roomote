import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';

import jwt from 'jsonwebtoken';
import { z } from 'zod';
import pMap from 'p-map';

import {
  type CreateGitHubTokenOptions,
  type CreateGitHubTokenRuntimeOptions,
  type GitHubTokenMetadata,
  createGitHubTokenWithMetadata,
  resolveGitHubAppCredentials,
} from '@roomote/auth';
import {
  DEFAULT_SOURCE_CONTROL_PROVIDER,
  filterRepositoryNamesForSourceControlProvider,
  normalizePemEnvValue,
} from '@roomote/types';
import {
  type GitHubInstallation,
  type Repository,
  type TaskRun,
  db,
  githubPendingInstallations,
  githubInstallations,
  environments,
  repositories,
  and,
  eq,
  isNull,
  inArray,
  or,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';

const CONCURRENCY = 10;
const ALL_REPOSITORIES = '__all_repositories__';
const ANALYTICS_CONCURRENCY = 4;
const ANALYTICS_PULL_REQUESTS_PER_PAGE = 100;
const ANALYTICS_MAX_ALL_TIME_PULL_REQUEST_PAGES = 50;

async function resolveTokenOptionsForRepositoryNames({
  taskRun,
  repositoryNames,
  missingMessagePrefix,
  spanningMessagePrefix,
}: {
  taskRun: TaskRun;
  repositoryNames: string[];
  missingMessagePrefix: string;
  spanningMessagePrefix: string;
}): Promise<CreateGitHubTokenOptions> {
  const uniqueRepositoryNames = [
    ...new Set(
      filterRepositoryNamesForSourceControlProvider(
        taskRun.payload,
        repositoryNames.filter(Boolean),
        DEFAULT_SOURCE_CONTROL_PROVIDER,
      ),
    ),
  ];

  const selectedRepoRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, DEFAULT_SOURCE_CONTROL_PROVIDER),
      eq(repositories.isActive, true),
      inArray(repositories.fullName, uniqueRepositoryNames),
    ),
  });

  const foundRepositories = new Set(
    selectedRepoRows.map((repository) => repository.fullName),
  );
  const missingRepositories = uniqueRepositoryNames.filter(
    (fullName) => !foundRepositories.has(fullName),
  );

  if (missingRepositories.length > 0) {
    throw new Error(
      `${missingMessagePrefix} for task run ${taskRun.id}: ${missingRepositories.join(', ')}`,
    );
  }

  const installationIds = [
    ...new Set(
      selectedRepoRows
        .map((repository) => repository.installationId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (installationIds.length === 1 && installationIds[0]) {
    // Scope the token to exactly the task's repositories instead of the whole
    // installation, so a task cannot reach unrelated repos in the org.
    const repositoryIds = selectedRepoRows
      .map((repository) => repository.githubRepoId)
      .filter((id): id is number => id != null);

    // Fail closed: if the task selected repositories but none resolved to a
    // GitHub repo id, do not mint an installation-wide token. Escalating back to
    // every repo in the org would defeat the scoping this path guarantees.
    if (repositoryIds.length === 0) {
      throw new Error(
        `${spanningMessagePrefix} for task run ${taskRun.id} resolved no GitHub repository ids for selected repositories: ${uniqueRepositoryNames.join(', ')}`,
      );
    }

    return {
      type: 'installationId',
      installationId: installationIds[0],
      repositoryIds,
    };
  }

  throw new Error(
    `${spanningMessagePrefix} for task run ${taskRun.id} span multiple GitHub installations: ${uniqueRepositoryNames.join(', ')}`,
  );
}

/**
 * Types: Pull Requests
 */

type Pulls = RestEndpointMethodTypes['pulls'];

export type PullRequest = Pulls['get']['response']['data'];

export type PullRequestListItem = Pulls['list']['response']['data'][number];

export type PullRequestAnalyticsState = 'open' | 'draft' | 'closed' | 'merged';

export type PullRequestAnalyticsItem = {
  authorLogin: string | null;
  /**
   * Carried for pull-request facts, not for analytics. Absent or null means
   * "this reader did not look", so a write must leave a stored value alone;
   * the fact-backed analytics query omits both rather than paying to select
   * PR bodies nothing renders.
   */
  body?: string | null;
  labels?: string[] | null;
  createdAt: string;
  externalPullRequestId: number;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  number: number;
  repoFullName: string;
  state: PullRequestAnalyticsState;
  title: string;
  url: string;
};

export type ReviewComment =
  Pulls['listReviewComments']['response']['data'][number];

type PullRequestListSort = 'created' | 'updated';

/**
 * Types: Issues
 */

type Issues = RestEndpointMethodTypes['issues'];

export type Issue = Issues['get']['response']['data'];

export type IssueListItem = Issues['list']['response']['data'][number];

export type IssueComment = Issues['listComments']['response']['data'][number];

/**
 * Types: Reactions
 */

type Reactions = RestEndpointMethodTypes['reactions'];

/**
 * Types: Checks
 */

type Checks = RestEndpointMethodTypes['checks'];

/**
 * Authentication
 */

async function resolveTaskRunGitHubTokenOptions(
  taskRun: TaskRun,
): Promise<CreateGitHubTokenOptions> {
  if (taskRun.payload.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, taskRun.payload.environmentId),
    });

    if (!environment) {
      throw new Error(
        `Environment not found for task run ${taskRun.id}: ${taskRun.payload.environmentId}`,
      );
    }

    const environmentRepositories = environment.config.repositories.map(
      (repository) => repository.repository,
    );

    if (environmentRepositories.length > 0) {
      return resolveTokenOptionsForRepositoryNames({
        taskRun,
        repositoryNames: environmentRepositories,
        missingMessagePrefix: 'Environment repositories not found',
        spanningMessagePrefix: 'Environment repositories',
      });
    }
  }

  const selectedRepositories = Array.isArray(
    taskRun.payload.selectedRepositories,
  )
    ? [...new Set(taskRun.payload.selectedRepositories.filter(Boolean))]
    : [];

  if (selectedRepositories.length > 0) {
    return resolveTokenOptionsForRepositoryNames({
      taskRun,
      repositoryNames: selectedRepositories,
      missingMessagePrefix: 'Selected repositories not found',
      spanningMessagePrefix: 'Selected repositories',
    });
  }

  const repo =
    taskRun.payload.repo && taskRun.payload.repo !== ALL_REPOSITORIES
      ? await db.query.repositories.findFirst({
          where: and(
            eq(
              repositories.sourceControlProvider,
              DEFAULT_SOURCE_CONTROL_PROVIDER,
            ),
            eq(repositories.fullName, taskRun.payload.repo),
            eq(repositories.isActive, true),
          ),
        })
      : undefined;

  const installationId = repo?.installationId;

  return installationId
    ? { type: 'installationId', installationId }
    : { type: 'activeInstallation' };
}

export async function createTaskRunGitHubTokenWithMetadata(
  taskRun: TaskRun,
  runtimeOptions?: CreateGitHubTokenRuntimeOptions,
): Promise<GitHubTokenMetadata> {
  const options = await resolveTaskRunGitHubTokenOptions(taskRun);
  return createGitHubTokenWithMetadata(options, undefined, runtimeOptions);
}

export const createTaskRunGitHubToken = async (
  taskRun: TaskRun,
  runtimeOptions?: CreateGitHubTokenRuntimeOptions,
): Promise<string> => {
  const metadata = await createTaskRunGitHubTokenWithMetadata(
    taskRun,
    runtimeOptions,
  );
  return metadata.token;
};

export type TaskRunWorkerGitHubToken = {
  token: string;
  source: 'user' | 'app';
  expiresAt: Date | null;
};

/**
 * Create the GH_TOKEN for runtime worker operations.
 *
 * Always uses the app-scoped GitHub installation token. User OAuth
 * tokens are intentionally NOT used here because they carry the full
 * privileges of the linked GitHub user (e.g. bypassing branch
 * protection / required reviews), which is a security risk.
 *
 * GitHub account linking is preserved so we know *who* triggered a job,
 * but the token used for git operations is always the App installation
 * token with its constrained permission set.
 */
export async function createTaskRunWorkerGitHubTokenWithMetadata(
  taskRun: TaskRun,
): Promise<TaskRunWorkerGitHubToken> {
  const metadata = await createTaskRunGitHubTokenWithMetadata(taskRun);
  return {
    token: metadata.token,
    source: 'app',
    expiresAt: metadata.expiresAt,
  };
}

export async function createTaskRunWorkerGitHubToken(
  taskRun: TaskRun,
): Promise<string> {
  const result = await createTaskRunWorkerGitHubTokenWithMetadata(taskRun);
  return result.token;
}

/**
 * Pagination
 */

export type PaginateOptions = {
  perPage?: number;
  stopAfter?: number;
};

async function paginate<T>(
  fetcher: (page: number, perPage: number) => Promise<T[]>,
  { perPage = 100, stopAfter }: PaginateOptions = {},
): Promise<T[]> {
  const entries: T[] = [];
  let page = 1;

  while (true) {
    const items = await fetcher(page, perPage);

    if (items.length === 0) {
      break;
    }

    entries.push(...items);

    if (items.length < perPage) {
      break;
    }

    if (stopAfter && entries.length >= stopAfter) {
      break;
    }

    page++;
  }

  return entries;
}

/**
 * Paginate through API results that require filtering.
 * Checks raw API response count before applying filter to ensure all pages are
 * fetched.
 */
async function paginateWithFilter<TRaw, TFiltered>(
  fetcher: (page: number, perPage: number) => Promise<TRaw[]>,
  filter: (items: TRaw[]) => TFiltered[],
  { perPage = 100, stopAfter }: PaginateOptions = {},
): Promise<TFiltered[]> {
  const entries: TFiltered[] = [];
  let page = 1;

  while (true) {
    const rawItems = await fetcher(page, perPage);
    const rawCount = rawItems.length;

    if (rawCount === 0) {
      break;
    }

    const filteredItems = filter(rawItems);
    entries.push(...filteredItems);

    if (rawCount < perPage) {
      break;
    }

    if (stopAfter && entries.length >= stopAfter) {
      break;
    }

    page++;
  }

  return entries;
}

function generateJWT(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iat: now,
      exp: now + 300,
      iss: appId,
    },
    normalizePemEnvValue(
      privateKey.replace(/\\n/g, '\n').replace(/"/g, '').trim(),
    ),
    { algorithm: 'RS256' },
  );
}

/**
 * Octokit
 */

const GITHUB_RATE_LIMIT_MAX_RETRIES = 2;
const GITHUB_RATE_LIMIT_MAX_DELAY_MS = 30_000;
const GITHUB_RATE_LIMIT_FALLBACK_DELAY_MS = 1_000;
const GITHUB_RATE_LIMIT_DEFAULT_DEFER_MS = 15 * 60 * 1_000;
const GITHUB_RATE_LIMIT_MAX_DEFER_MS = 60 * 60 * 1_000;

type GitHubOctokitRuntimeOptions = {
  retryRateLimits?: boolean;
};

function getHeader(response: Response, name: string): string | null {
  return response.headers.get(name);
}

function getHeaderValue(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) {
    return null;
  }

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  const value = Object.entries(headers as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return typeof value === 'string' ? value : null;
}

function getErrorHeader(error: unknown, name: string): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const topLevelHeaders =
    'headers' in error ? getHeaderValue(error.headers, name) : null;
  if (topLevelHeaders !== null) {
    return topLevelHeaders;
  }

  if (
    !('response' in error) ||
    typeof error.response !== 'object' ||
    error.response === null ||
    !('headers' in error.response)
  ) {
    return null;
  }

  return getHeaderValue(error.response.headers, name);
}

function isGraphQlRateLimitError(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('errors' in error) ||
    !Array.isArray(error.errors)
  ) {
    return false;
  }

  return error.errors.some((item) => {
    if (typeof item !== 'object' || item === null) {
      return false;
    }

    const type = 'type' in item ? item.type : null;
    const extensions =
      'extensions' in item &&
      typeof item.extensions === 'object' &&
      item.extensions !== null
        ? item.extensions
        : null;
    const code = extensions && 'code' in extensions ? extensions.code : null;
    return type === 'RATE_LIMITED' || code === 'RATE_LIMITED';
  });
}

/** Returns a durable retry delay for GitHub primary or secondary rate limits. */
export function getGitHubRateLimitRetryAfterMs(
  error: unknown,
  nowMs = Date.now(),
): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const status = 'status' in error ? Number(error.status) : null;
  const graphQlRateLimited = isGraphQlRateLimitError(error);
  const retryAfter = getErrorHeader(error, 'retry-after');
  const remaining = getErrorHeader(error, 'x-ratelimit-remaining');
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const endpointSpammed =
    status === 422 &&
    (message.includes('endpoint has been spammed') ||
      message.includes('abuse detection'));

  if (
    status !== 403 &&
    status !== 429 &&
    !graphQlRateLimited &&
    !endpointSpammed
  ) {
    return null;
  }

  const isRateLimit =
    graphQlRateLimited ||
    endpointSpammed ||
    status === 429 ||
    retryAfter !== null ||
    remaining === '0' ||
    message.includes('api rate limit exceeded') ||
    message.includes('secondary rate limit') ||
    message.includes('abuse detection');

  if (!isRateLimit) {
    return null;
  }

  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    const delayMs = Number.isFinite(seconds)
      ? seconds * 1_000
      : retryAt - nowMs;
    if (Number.isFinite(delayMs) && delayMs > 0) {
      return Math.min(delayMs, GITHUB_RATE_LIMIT_MAX_DEFER_MS);
    }
  }

  const resetSeconds = Number(getErrorHeader(error, 'x-ratelimit-reset'));
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    const delayMs = resetSeconds * 1_000 - nowMs + 1_000;
    if (delayMs > 0) {
      return Math.min(delayMs, GITHUB_RATE_LIMIT_MAX_DEFER_MS);
    }
  }

  return GITHUB_RATE_LIMIT_DEFAULT_DEFER_MS;
}

async function isGitHubRateLimitResponse(response: Response): Promise<boolean> {
  if (response.status === 429) {
    return true;
  }

  if (response.status !== 403) {
    return false;
  }

  if (
    getHeader(response, 'retry-after') !== null ||
    getHeader(response, 'x-ratelimit-remaining') === '0'
  ) {
    return true;
  }

  const body = (await response.clone().text()).toLowerCase();
  return (
    body.includes('secondary rate limit') || body.includes('abuse detection')
  );
}

function getGitHubRateLimitDelayMs(
  response: Response,
  retryNumber: number,
): number {
  const retryAfter = getHeader(response, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    const delayMs = Number.isFinite(seconds)
      ? seconds * 1_000
      : retryAt - Date.now();

    if (Number.isFinite(delayMs) && delayMs > 0) {
      return Math.min(delayMs, GITHUB_RATE_LIMIT_MAX_DELAY_MS);
    }
  }

  const resetSeconds = Number(getHeader(response, 'x-ratelimit-reset'));
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    // Give GitHub one second beyond the advertised epoch boundary.
    const delayMs = resetSeconds * 1_000 - Date.now() + 1_000;
    if (delayMs > 0) {
      return Math.min(delayMs, GITHUB_RATE_LIMIT_MAX_DELAY_MS);
    }
  }

  // GitHub advises pausing before retrying secondary limits when it omits an
  // explicit delay. Use the request-safe ceiling rather than a tight loop.
  if (response.status === 403) {
    return GITHUB_RATE_LIMIT_MAX_DELAY_MS;
  }

  return Math.min(
    GITHUB_RATE_LIMIT_FALLBACK_DELAY_MS * 2 ** retryNumber,
    GITHUB_RATE_LIMIT_MAX_DELAY_MS,
  );
}

function createGitHubRateLimitRetryFetch(): typeof fetch {
  return async (input, init) => {
    for (let retryNumber = 0; ; retryNumber++) {
      const response = await globalThis.fetch(
        input instanceof Request ? input.clone() : input,
        init,
      );
      if (
        retryNumber >= GITHUB_RATE_LIMIT_MAX_RETRIES ||
        !(await isGitHubRateLimitResponse(response))
      ) {
        return response;
      }

      await response.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, getGitHubRateLimitDelayMs(response, retryNumber)),
      );
    }
  };
}

function createOctokit(
  options: ConstructorParameters<typeof Octokit>[0],
  runtimeOptions: GitHubOctokitRuntimeOptions = {},
): Octokit {
  return new Octokit({
    ...options,
    request: {
      ...options?.request,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options?.request?.headers ?? {}),
      },
      fetch: runtimeOptions.retryRateLimits
        ? createGitHubRateLimitRetryFetch()
        : (input: RequestInfo | URL, init?: RequestInit) =>
            globalThis.fetch(input, init),
    },
  });
}

export function getOctokit(
  auth: string,
  runtimeOptions: GitHubOctokitRuntimeOptions = {},
): Octokit {
  return createOctokit({ auth, userAgent: 'Roomote' }, runtimeOptions);
}

/**
 * Get an Octokit instance authenticated as the GitHub App using JWT.
 */
export function getAppOctokit(): Octokit {
  const { appId, privateKey } = resolveGitHubAppCredentials();

  return createOctokit({
    auth: generateJWT(appId, privateKey),
    userAgent: 'Roomote',
  });
}

async function resolveDeploymentGitHubAppCredentials() {
  const [appId, privateKey] = await Promise.all([
    resolveDeploymentEnvVar('R_GITHUB_APP_ID'),
    resolveDeploymentEnvVar('R_GITHUB_APP_PRIVATE_KEY'),
  ]);

  if (!appId || !privateKey) {
    throw new Error('GitHub App credentials are not configured.');
  }

  return { appId, privateKey };
}

export async function getResolvedAppOctokit(): Promise<Octokit> {
  const { appId, privateKey } = await resolveDeploymentGitHubAppCredentials();

  return createOctokit({
    auth: generateJWT(appId, privateKey),
    userAgent: 'Roomote',
  });
}

export async function getInstallationOctokit({
  installationId,
}: Pick<GitHubInstallation, 'installationId'>): Promise<Octokit> {
  const appOctokit = await getResolvedAppOctokit();
  const {
    data: { token: auth },
  } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });

  return createOctokit({ auth, userAgent: 'Roomote' });
}

export async function getRepositoryOctokit({
  userId,
  owner,
  repo,
}: {
  userId: string;
  owner: string;
  repo: string;
}): Promise<Octokit> {
  const fullName = `${owner}/${repo}`;

  const repository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, DEFAULT_SOURCE_CONTROL_PROVIDER),
      eq(repositories.fullName, fullName),
      eq(repositories.isActive, true),
    ),
    with: { githubInstallation: true },
  });

  if (!repository) {
    throw new Error(`Unable to find ${fullName} repository for user ${userId}`);
  }

  if (!repository.githubInstallation) {
    throw new Error(`Unable to find GitHub installation for ${fullName}`);
  }

  return getInstallationOctokit(repository.githubInstallation);
}

type RepositoryWithOctokit = Repository & {
  githubInstallation: GitHubInstallation;
  octokit: Octokit;
};

async function getRepositoriesWithOctokit({
  userId,
  repositoryIds,
}: {
  userId: string;
  repositoryIds?: string[];
}): Promise<RepositoryWithOctokit[]> {
  const repos = await db.query.repositories.findMany({
    where: and(
      repositoryIds ? inArray(repositories.id, repositoryIds) : undefined,
      eq(repositories.sourceControlProvider, DEFAULT_SOURCE_CONTROL_PROVIDER),
      eq(repositories.isActive, true),
    ),
    with: { githubInstallation: true },
  });

  if (repos.length === 0) {
    return [];
  }

  const githubRepos = repos.filter(
    (repo): repo is typeof repo & { githubInstallation: GitHubInstallation } =>
      !!repo.githubInstallation,
  );

  // Get unique github installations.
  const githubInstallations = Array.from(
    new Map(
      githubRepos.map((repo) => [
        repo.githubInstallation.id,
        repo.githubInstallation,
      ]),
    ).values(),
  );

  const sync = new Set<number>();

  // Get octokits for all unique github installations.
  const octokits = (
    await pMap(
      githubInstallations,
      async (githubInstallation) => {
        try {
          const octokit = await getInstallationOctokit(githubInstallation);
          return { id: githubInstallation.id, octokit };
        } catch (error) {
          sync.add(githubInstallation.installationId);

          console.error(
            `[getRepositoriesWithOctokit] getInstallationOctokit(${githubInstallation.id}) failed -> ${typeof error}: ${error instanceof Error ? error.message : String(error)}`,
          );

          return { id: githubInstallation.id, octokit: null };
        }
      },
      { concurrency: CONCURRENCY },
    )
  ).reduce(
    (acc, { id, octokit }) => ({ ...acc, [id]: octokit }),
    {} as Record<string, Octokit | null>,
  );

  if (sync.size > 0) {
    for (const installationId of sync) {
      await syncGitHubInstallation({ userId, installationId });
    }
  }

  return githubRepos
    .map((repo) => ({
      ...repo,
      octokit: octokits[repo.githubInstallation.id],
    }))
    .filter((repo): repo is RepositoryWithOctokit => !!repo.octokit);
}

/**
 * Sync
 */

export async function syncGitHubInstallations({ userId }: { userId: string }) {
  const installations = await db.query.githubInstallations.findMany({
    where: isNull(githubInstallations.suspendedAt),
  });

  return pMap(
    installations,
    async (installation) =>
      syncGitHubInstallation({
        userId,
        installationId: installation.installationId,
      }),
    { concurrency: CONCURRENCY },
  );
}

export async function syncGitHubInstallation({
  userId,
  installationId,
}: {
  userId: string;
  installationId: number;
}): Promise<
  | {
      success: true;
      githubInstallation: GitHubInstallation;
      repositories: Repository[];
    }
  | { success: false; error: string }
> {
  try {
    const installation = await getGitHubInstallation(installationId);

    if (!installation.account) {
      throw new Error('Installation account information not available');
    }

    // Handle both `User` and `Organization` account types.
    const accountLogin =
      'login' in installation.account
        ? installation.account.login
        : installation.account.name;

    const accountType =
      'type' in installation.account ? installation.account.type : 'User';

    let membersCount: number | null = null;

    if (accountType === 'Organization') {
      membersCount = await getOrganizationMembersCount(
        installationId,
        accountLogin,
      );
    }

    const existingInstallation = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.installationId, installationId),
    });

    const appCredentials = await resolveDeploymentGitHubAppCredentials();
    const appId = parseInt(appCredentials.appId, 10);

    if (existingInstallation) {
      await db
        .update(githubInstallations)
        .set({
          appId,
          accountLogin,
          accountType,
          permissions: installation.permissions,
          membersCount,
          suspendedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(githubInstallations.id, existingInstallation.id));
    } else {
      await db.insert(githubInstallations).values({
        userId: null,
        installationId,
        appId,
        accountLogin,
        accountType,
        permissions: installation.permissions,
        membersCount,
        installedByUserId: userId,
      });
    }

    const githubInstallation = await db.query.githubInstallations.findFirst({
      where: and(
        eq(githubInstallations.installationId, installationId),
        isNull(githubInstallations.suspendedAt),
      ),
    });

    if (!githubInstallation) {
      throw new Error('GitHub installation not found.');
    }

    const repositories = await syncRepositories({
      userId,
      githubInstallation,
    });

    return { success: true, githubInstallation, repositories };
  } catch (error) {
    console.error(
      `[syncGitHubInstallation] Failed to sync GitHub installation: ${error instanceof Error ? error.message : String(error)}`,
    );

    if (
      error instanceof Error &&
      'response' in error &&
      typeof error.response === 'object'
    ) {
      const response = z
        .object({
          status: z.number(),
          url: z.string(),
        })
        .safeParse(error.response);

      if (response.success) {
        const { status, url } = response.data;

        if (
          status === 404 &&
          url === `https://api.github.com/app/installations/${installationId}`
        ) {
          await suspendGitHubInstallation({ installationId });
        }
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type GitHubInstallationRepository =
  RestEndpointMethodTypes['apps']['listReposAccessibleToInstallation']['response']['data']['repositories'][number];

type SyncableGitHubRepository = Pick<
  GitHubInstallationRepository,
  | 'id'
  | 'name'
  | 'full_name'
  | 'description'
  | 'private'
  | 'default_branch'
  | 'clone_url'
  | 'html_url'
  | 'permissions'
>;

export async function upsertGitHubRepository({
  userId,
  githubInstallationId,
  gitHubRepo,
}: {
  userId: string;
  githubInstallationId: string;
  gitHubRepo: SyncableGitHubRepository;
}): Promise<Repository> {
  const values = {
    sourceControlProvider: DEFAULT_SOURCE_CONTROL_PROVIDER,
    host: 'github.com',
    installationId: githubInstallationId,
    githubRepoId: gitHubRepo.id,
    externalRepoId: String(gitHubRepo.id),
    name: gitHubRepo.name,
    fullName: gitHubRepo.full_name,
    description: gitHubRepo.description,
    private: gitHubRepo.private,
    defaultBranch: gitHubRepo.default_branch,
    cloneUrl: gitHubRepo.clone_url,
    htmlUrl: gitHubRepo.html_url,
    permissions: gitHubRepo.permissions,
    isActive: true,
  };

  const [insertedRepository] = await db
    .insert(repositories)
    .values({
      userId: null,
      linkedByUserId: userId,
      ...values,
    })
    .onConflictDoNothing()
    .returning();

  if (insertedRepository) {
    return insertedRepository;
  }

  // A concurrent sync may have inserted this repository, while historical
  // rows can conflict on external id or full name even if their GitHub id is
  // stale. Reconcile whichever persisted identity caused the conflict.
  const matchingRepositories = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, DEFAULT_SOURCE_CONTROL_PROVIDER),
      or(
        eq(repositories.githubRepoId, gitHubRepo.id),
        and(
          eq(repositories.host, 'github.com'),
          or(
            eq(repositories.externalRepoId, String(gitHubRepo.id)),
            eq(repositories.fullName, gitHubRepo.full_name),
          ),
        ),
      ),
    ),
  });

  if (matchingRepositories.length === 0) {
    throw new Error(
      `GitHub repository conflict could not be reconciled: ${gitHubRepo.full_name}`,
    );
  }

  if (matchingRepositories.length > 1) {
    throw new Error(
      `GitHub repository identity is ambiguous for ${gitHubRepo.full_name}: matched ${matchingRepositories.length} persisted repositories`,
    );
  }

  const existingRepository = matchingRepositories[0]!;

  const [updatedRepository] = await db
    .update(repositories)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(repositories.id, existingRepository.id))
    .returning();

  if (!updatedRepository) {
    throw new Error(
      `GitHub repository could not be updated: ${gitHubRepo.full_name}`,
    );
  }

  return updatedRepository;
}

function isGitHubRepositoryEmpty(
  repository: Pick<GitHubInstallationRepository, 'size' | 'pushed_at'>,
) {
  // GitHub reports `size` in KB, so pair it with `pushed_at` to avoid
  // treating tiny freshly initialized repos as empty because of rounding.
  return repository.size === 0 && !repository.pushed_at;
}

async function syncRepositories({
  userId,
  githubInstallation,
}: {
  userId: string;
  githubInstallation: GitHubInstallation;
}) {
  const octokit = await getInstallationOctokit(githubInstallation);

  const existingIds = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(
            repositories.sourceControlProvider,
            DEFAULT_SOURCE_CONTROL_PROVIDER,
          ),
          eq(repositories.installationId, githubInstallation.id),
          eq(repositories.isActive, true),
        ),
      )
  ).map((repo) => repo.id);

  const reposAccessibleToInstallation = await paginate(
    async (page, perPage) => {
      const { data } =
        await octokit.rest.apps.listReposAccessibleToInstallation({
          per_page: perPage,
          page,
        });

      return data.repositories;
    },
    {},
  );

  // Upsert fetched repositories and set them to active.
  const repos = await pMap(
    reposAccessibleToInstallation,
    (gitHubRepo) =>
      upsertGitHubRepository({
        userId,
        githubInstallationId: githubInstallation.id,
        gitHubRepo,
      }),
    { concurrency: CONCURRENCY },
  );

  const updatedIds = new Set(repos.map(({ id }) => id));
  const missingIds = existingIds.filter((id) => !updatedIds.has(id));

  if (missingIds.length > 0) {
    await db
      .update(repositories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(repositories.id, missingIds));
  }

  return repos;
}

export async function getRepositoryEmptyStates({
  repositoryIds,
}: {
  repositoryIds?: string[];
}): Promise<Map<string, boolean>> {
  const uniqueRepositoryIds = repositoryIds
    ? [...new Set(repositoryIds)]
    : undefined;

  if (uniqueRepositoryIds?.length === 0) {
    return new Map<string, boolean>();
  }

  const repositoriesWhere = uniqueRepositoryIds
    ? and(
        eq(repositories.isActive, true),
        inArray(repositories.id, uniqueRepositoryIds),
      )
    : eq(repositories.isActive, true);

  const activeRepositories = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, DEFAULT_SOURCE_CONTROL_PROVIDER),
      repositoriesWhere,
    ),
    with: {
      githubInstallation: true,
    },
  });

  type ActiveRepositoryWithGitHubInstallation =
    (typeof activeRepositories)[number] & {
      githubInstallation: GitHubInstallation;
      installationId: string;
      githubRepoId: number;
    };

  const repositoriesByInstallation = new Map<
    string,
    {
      githubInstallation: GitHubInstallation;
      repositories: ActiveRepositoryWithGitHubInstallation[];
    }
  >();

  for (const repository of activeRepositories) {
    if (
      !repository.installationId ||
      !repository.githubRepoId ||
      !repository.githubInstallation
    ) {
      continue;
    }

    if (repository.githubInstallation.suspendedAt) {
      continue;
    }

    const githubRepository: ActiveRepositoryWithGitHubInstallation = {
      ...repository,
      githubInstallation: repository.githubInstallation,
      installationId: repository.installationId,
      githubRepoId: repository.githubRepoId,
    };

    const existing = repositoriesByInstallation.get(
      githubRepository.installationId,
    );

    if (existing) {
      existing.repositories.push(githubRepository);
      continue;
    }

    repositoriesByInstallation.set(githubRepository.installationId, {
      githubInstallation: githubRepository.githubInstallation,
      repositories: [githubRepository],
    });
  }

  const emptyStates = new Map<string, boolean>();

  await pMap(
    [...repositoriesByInstallation.values()],
    async ({ githubInstallation, repositories: installationRepositories }) => {
      const octokit = await getInstallationOctokit(githubInstallation);
      const repositoriesAccessibleToInstallation = await paginate(
        async (page, perPage) => {
          const { data } =
            await octokit.rest.apps.listReposAccessibleToInstallation({
              per_page: perPage,
              page,
            });

          return data.repositories;
        },
        {},
      );
      const gitHubReposById = new Map(
        repositoriesAccessibleToInstallation.map((repository) => [
          repository.id,
          repository,
        ]),
      );

      for (const repository of installationRepositories) {
        const gitHubRepository = repository.githubRepoId
          ? gitHubReposById.get(repository.githubRepoId)
          : undefined;

        if (!gitHubRepository) {
          continue;
        }

        emptyStates.set(
          repository.id,
          isGitHubRepositoryEmpty(gitHubRepository),
        );
      }
    },
    { concurrency: CONCURRENCY },
  );

  return emptyStates;
}

/**
 * GitHub Installation
 */

export async function getGitHubInstallation(installationId: number) {
  const appOctokit = await getResolvedAppOctokit();
  const { data } = await appOctokit.rest.apps.getInstallation({
    installation_id: installationId,
  });

  return data;
}

export async function getGitHubInstallations(options?: PaginateOptions) {
  const octokit = await getResolvedAppOctokit();

  const installations = await paginate(async (page, perPage) => {
    const { data } = await octokit.rest.apps.listInstallations({
      per_page: perPage,
      page,
    });

    return data;
  }, options);

  return installations;
}

// Sync the installation for the requester recorded on this specific pending
// row, then delete that row. Callers pass the exact row they intend to
// complete so completion is never re-resolved by the non-unique account id.
async function completePendingGitHubInstallationRow(
  pendingGitHubInstallation: typeof githubPendingInstallations.$inferSelect,
  installationId: number,
) {
  const { id: pendingId, requestedByUserId: userId } =
    pendingGitHubInstallation;

  const result = await syncGitHubInstallation({
    userId,
    installationId,
  });

  if (result.success) {
    try {
      // Clean up the pending GitHub installation upon successful completion.
      await db
        .delete(githubPendingInstallations)
        .where(eq(githubPendingInstallations.id, pendingId));
    } catch (error) {
      console.error(
        `[completePendingGitHubInstallation] Failed to delete pending GitHub installation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return { ...result, requestedByUserId: userId };
  }

  return result;
}

export async function completePendingGitHubInstallation(
  installationId: number,
) {
  const installation = await getGitHubInstallation(installationId);

  if (!installation.account) {
    throw new Error('Installation account information not available');
  }

  const pendingGitHubInstallation =
    await db.query.githubPendingInstallations.findFirst({
      where: eq(githubPendingInstallations.appId, installation.account.id),
    });

  if (!pendingGitHubInstallation) {
    throw new Error('Pending GitHub installation not found');
  }

  return completePendingGitHubInstallationRow(
    pendingGitHubInstallation,
    installationId,
  );
}

/**
 * Complete the requesting user's pending GitHub installations whose requests
 * have since been approved on GitHub. This covers the case where the
 * `installation.created` webhook never reached this deployment (for example a
 * misconfigured webhook URL), leaving the requester stuck on "pending".
 *
 * Scoped to a single user so one user's manual re-check can never complete (or
 * report as approved) another user's request.
 */
export async function resolvePendingGitHubInstallations({
  userId,
}: {
  userId: string;
}): Promise<{
  pending: number;
  completed: number;
}> {
  const pendingGitHubInstallations =
    await db.query.githubPendingInstallations.findMany({
      where: eq(githubPendingInstallations.requestedByUserId, userId),
    });

  if (pendingGitHubInstallations.length === 0) {
    return { pending: 0, completed: 0 };
  }

  const installations = await getGitHubInstallations();

  let completed = 0;

  for (const pendingGitHubInstallation of pendingGitHubInstallations) {
    // The pending row's `appId` holds the id of the GitHub account the
    // installation was requested for.
    const installation = installations.find(
      ({ account }) => account?.id === pendingGitHubInstallation.appId,
    );

    if (!installation) {
      continue;
    }

    try {
      // Complete this exact row (not a re-lookup by account id), so a shared
      // organization between two requesters can't complete the other's row.
      const result = await completePendingGitHubInstallationRow(
        pendingGitHubInstallation,
        installation.id,
      );

      if (result.success) {
        completed += 1;
      }
    } catch (error) {
      console.error(
        `[resolvePendingGitHubInstallations] Failed to complete pending GitHub installation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    pending: pendingGitHubInstallations.length - completed,
    completed,
  };
}

async function suspendGitHubInstallation({
  installationId,
}: {
  installationId: number;
}) {
  console.warn(
    `[suspendGitHubInstallation] suspending installation -> ${installationId}`,
  );

  await db
    .update(githubInstallations)
    .set({ suspendedAt: new Date() })
    .where(eq(githubInstallations.installationId, installationId));

  const githubInstallation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
  });

  if (githubInstallation) {
    await db
      .update(repositories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(
            repositories.sourceControlProvider,
            DEFAULT_SOURCE_CONTROL_PROVIDER,
          ),
          eq(repositories.installationId, githubInstallation.id),
        ),
      );
  }
}

/**
 * Repository
 */

export async function suspendRepository(repository: Repository) {
  console.warn(
    `[suspendRepository] suspending repository -> ${repository.fullName}`,
  );

  await db
    .update(repositories)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(repositories.id, repository.id));
}

/**
 * Branches
 */

export async function getBranches({
  fullName,
  options,
}: {
  userId: string;
  fullName: string;
  options?: PaginateOptions;
}) {
  const repository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, DEFAULT_SOURCE_CONTROL_PROVIDER),
      eq(repositories.fullName, fullName),
      eq(repositories.isActive, true),
    ),
    with: { githubInstallation: true },
  });

  if (!repository) {
    return [];
  }

  if (!repository.githubInstallation) {
    return [];
  }

  const [owner, repo] = fullName.split('/');

  const octokit = await getInstallationOctokit(repository.githubInstallation);

  const branches = await paginate(async (page, perPage) => {
    const { data } = await octokit.rest.repos.listBranches({
      owner: owner!,
      repo: repo!,
      per_page: perPage,
      page,
    });

    return data.map((branch) => branch.name);
  }, options);

  const index = branches.indexOf(repository.defaultBranch);

  if (index > -1) {
    branches.splice(index, 1);
  }

  return [repository.defaultBranch, ...branches];
}

/**
 * Collaborators
 */

export async function getCollaborators({
  userId,
  repositoryIds,
  options,
}: {
  userId: string;
  repositoryIds?: string[];
  options?: PaginateOptions;
}) {
  const repos = await getRepositoriesWithOctokit({
    userId,
    repositoryIds,
  });

  if (repos.length === 0) {
    return [];
  }

  const members = (
    await pMap(
      repos,
      async (repository) => {
        const { fullName, octokit } = repository;
        const [owner, repo] = fullName.split('/');

        try {
          const { data } = await octokit.rest.repos.get({
            owner: owner!,
            repo: repo!,
          });

          if (data.owner.type === 'Organization') {
            const members = await octokit.rest.orgs.listMembers({
              org: data.owner.login,
            });

            return members.data.map(({ login }) => login);
          } else {
            return [data.owner.login];
          }
        } catch (error) {
          if (error instanceof Error && 'status' in error) {
            console.error(
              `[getCollaborators] repos.get or orgs.listMembers failed for ${fullName} -> status: ${error.status}, message: ${error.message}`,
            );
          } else {
            console.error(
              `[getCollaborators] repos.get or orgs.listMembers failed for ${fullName} -> ${typeof error}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          return [];
        }
      },
      { concurrency: CONCURRENCY },
    )
  )
    .flat()
    .filter((owner) => typeof owner === 'string');

  const collaborators = (
    await pMap(
      repos,
      async (repository) => {
        const { fullName, octokit } = repository;
        const [owner, repo] = fullName.split('/');

        return paginate(async (page, per_page) => {
          const params = { owner: owner!, repo: repo!, page, per_page };

          try {
            return (
              await octokit.rest.repos.listCollaborators(params)
            ).data.map(({ login, type }) =>
              type === 'User' ? login : undefined,
            );
          } catch (error) {
            if (error instanceof Error && 'status' in error) {
              console.error(
                `[getCollaborators] repos.listCollaborators failed for ${fullName} -> status: ${error.status}, message: ${error.message}`,
              );
            } else {
              console.error(
                `[getCollaborators] repos.listCollaborators failed for ${fullName} -> ${typeof error}:  ${error instanceof Error ? error.message : String(error)}`,
              );
            }

            return [];
          }
        }, options);
      },
      { concurrency: CONCURRENCY },
    )
  )
    .flat()
    .filter((collaborator) => typeof collaborator === 'string');

  const contributors =
    members.length === 0 && collaborators.length === 0
      ? (
          await pMap(
            repos,
            async (repository) => {
              const { fullName, octokit } = repository;
              const [owner, repo] = fullName.split('/');

              return paginate(async (page, per_page) => {
                const params = { owner: owner!, repo: repo!, page, per_page };

                try {
                  return (
                    await octokit.rest.repos.listContributors(params)
                  ).data.map(({ login, type }) =>
                    type === 'User' ? login : undefined,
                  );
                } catch (error) {
                  if (error instanceof Error && 'status' in error) {
                    console.error(
                      `[getCollaborators] repos.listContributors failed for ${fullName} -> status: ${error.status}, message: ${error.message}`,
                    );
                  } else {
                    console.error(
                      `[getCollaborators] repos.listContributors failed for ${fullName} -> ${typeof error}:  ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }

                  return [];
                }
              }, options);
            },
            { concurrency: CONCURRENCY },
          )
        )
          .flat()
          .filter((contributor) => typeof contributor === 'string')
      : [];

  return [...new Set([...members, ...collaborators, ...contributors])];
}

/**
 * Pull Requests
 */

export async function getPullRequests({
  userId,
  repositoryIds,
  options,
}: {
  userId: string;
  repositoryIds: string[];
  options?: PaginateOptions;
}): Promise<PullRequestListItem[]> {
  const repos = await getRepositoriesWithOctokit({
    userId,
    repositoryIds,
  });

  const pullRequests = await pMap(
    repos,
    async ({ fullName, octokit }) => {
      const [owner, repo] = fullName.split('/');

      return paginateWithFilter(
        async (page, perPage) => {
          const { data } = await octokit.rest.pulls.list({
            owner: owner!,
            repo: repo!,
            state: 'open',
            per_page: perPage,
            page,
            sort: 'created',
            direction: 'desc',
          });
          return data;
        },
        (data) =>
          data.filter(
            ({ locked, head: { repo } }) =>
              !locked && repo?.full_name === fullName,
          ),
        options,
      );
    },
    { concurrency: CONCURRENCY },
  );

  return pullRequests.flat();
}

function getPullRequestAnalyticsState(
  pullRequest: PullRequestListItem,
): PullRequestAnalyticsState {
  if (pullRequest.merged_at) {
    return 'merged';
  }

  if (pullRequest.draft) {
    return 'draft';
  }

  return pullRequest.state === 'closed' ? 'closed' : 'open';
}

function mapPullRequestToAnalyticsItem(
  fullName: string,
  pullRequest: PullRequestListItem,
): PullRequestAnalyticsItem {
  return {
    authorLogin: pullRequest.user?.login ?? null,
    body: pullRequest.body ?? null,
    labels: pullRequest.labels
      ? pullRequest.labels
          .map((label) => label.name)
          .filter((name): name is string => Boolean(name))
      : null,
    createdAt: pullRequest.created_at,
    externalPullRequestId: pullRequest.id,
    updatedAt: pullRequest.updated_at,
    closedAt: pullRequest.closed_at,
    mergedAt: pullRequest.merged_at,
    number: pullRequest.number,
    repoFullName: fullName,
    state: getPullRequestAnalyticsState(pullRequest),
    title: pullRequest.title,
    url: pullRequest.html_url,
  };
}

async function listRepositoryPullRequestsForAnalyticsBySort({
  fullName,
  octokit,
  createdAfter,
  updatedAfter,
  sort,
  perPage = ANALYTICS_PULL_REQUESTS_PER_PAGE,
  maxPages = createdAfter
    ? Number.POSITIVE_INFINITY
    : ANALYTICS_MAX_ALL_TIME_PULL_REQUEST_PAGES,
}: {
  fullName: string;
  octokit: Pick<Octokit, 'rest'>;
  createdAfter?: Date | null;
  updatedAfter?: Date | null;
  sort: PullRequestListSort;
  perPage?: number;
  maxPages?: number;
}): Promise<PullRequestAnalyticsItem[]> {
  const [owner, repo] = fullName.split('/');
  const results: PullRequestAnalyticsItem[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await octokit.rest.pulls.list({
      owner: owner!,
      repo: repo!,
      state: 'all',
      per_page: perPage,
      page,
      sort,
      direction: 'desc',
    });

    if (data.length === 0) {
      break;
    }

    let reachedCutoff = false;

    for (const pullRequest of data) {
      const createdAt = new Date(pullRequest.created_at);
      const updatedAt = new Date(pullRequest.updated_at);

      if (createdAfter && createdAt < createdAfter) {
        reachedCutoff = true;
        continue;
      }

      if (updatedAfter && updatedAt <= updatedAfter) {
        reachedCutoff = true;
        continue;
      }

      results.push(mapPullRequestToAnalyticsItem(fullName, pullRequest));
    }

    if (data.length < perPage || reachedCutoff) {
      break;
    }
  }

  return results;
}

export async function listRepositoryPullRequestsForAnalytics({
  fullName,
  octokit,
  createdAfter,
  perPage = ANALYTICS_PULL_REQUESTS_PER_PAGE,
  maxPages = createdAfter
    ? Number.POSITIVE_INFINITY
    : ANALYTICS_MAX_ALL_TIME_PULL_REQUEST_PAGES,
}: {
  fullName: string;
  octokit: Pick<Octokit, 'rest'>;
  createdAfter?: Date | null;
  perPage?: number;
  maxPages?: number;
}): Promise<PullRequestAnalyticsItem[]> {
  return listRepositoryPullRequestsForAnalyticsBySort({
    fullName,
    octokit,
    createdAfter,
    sort: 'created',
    perPage,
    maxPages,
  });
}

export async function getPullRequestsForAnalytics({
  userId,
  repositoryIds,
  createdAfter,
}: {
  userId: string;
  repositoryIds: string[];
  createdAfter?: Date | null;
}): Promise<PullRequestAnalyticsItem[]> {
  const repos = await getRepositoriesWithOctokit({
    userId,
    repositoryIds,
  });

  const pullRequests = await pMap(
    repos,
    ({ fullName, octokit }) =>
      listRepositoryPullRequestsForAnalytics({
        fullName,
        octokit,
        createdAfter,
      }),
    { concurrency: ANALYTICS_CONCURRENCY },
  );

  return pullRequests.flat();
}

export async function getUpdatedPullRequestsForAnalytics({
  userId,
  repositoryIds,
  updatedAfter,
}: {
  userId: string;
  repositoryIds: string[];
  updatedAfter?: Date | null;
}): Promise<PullRequestAnalyticsItem[]> {
  const repos = await getRepositoriesWithOctokit({
    userId,
    repositoryIds,
  });

  const pullRequests = await pMap(
    repos,
    ({ fullName, octokit }) =>
      listRepositoryPullRequestsForAnalyticsBySort({
        fullName,
        octokit,
        updatedAfter,
        sort: 'updated',
        maxPages: Number.POSITIVE_INFINITY,
      }),
    { concurrency: ANALYTICS_CONCURRENCY },
  );

  return pullRequests.flat();
}

export async function getPullRequest({
  userId,
  owner,
  repo,
  prNumber,
}: {
  userId: string;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<
  { success: true; data: PullRequest } | { success: false; error: string }
> {
  try {
    const octokit = await getRepositoryOctokit({ userId, owner, repo });

    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (data.locked) {
      return { success: false, error: 'Pull request is locked' };
    }

    if (!data.head.repo) {
      return { success: false, error: 'Pull request is from a deleted fork' };
    }

    return { success: true, data };
  } catch (error) {
    console.error(
      `[getPullRequest] ${error instanceof Error ? error.message : String(error)}`,
    );

    if (error instanceof Error && 'status' in error) {
      if (error.status === 404) {
        return { success: false, error: 'Pull request not found' };
      }
    }

    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to fetch pull request',
    };
  }
}

/**
 * Issues
 */

export async function getIssues({
  userId,
  repositoryIds,
  options,
}: {
  userId: string;
  repositoryIds: string[];
  options?: PaginateOptions;
}): Promise<(IssueListItem & { fullName: string })[]> {
  const repos = await getRepositoriesWithOctokit({
    userId,
    repositoryIds,
  });

  const issues = await pMap(
    repos,
    async ({ fullName, octokit }) => {
      const [owner, repo] = fullName.split('/');

      return paginateWithFilter(
        async (page, perPage) => {
          const { data: issues } = await octokit.rest.issues.listForRepo({
            owner: owner!,
            repo: repo!,
            state: 'open',
            per_page: perPage,
            page,
            sort: 'created',
            direction: 'desc',
          });

          return issues.map((issue) => ({ ...issue, fullName }));
        },
        (data) =>
          data.filter(({ locked, pull_request }) => !locked && !pull_request),
        options,
      );
    },
    { concurrency: CONCURRENCY },
  );

  return issues.flat();
}

export async function getIssue({
  userId,
  owner,
  repo,
  issueNumber,
}: {
  userId: string;
  owner: string;
  repo: string;
  issueNumber: number;
}): Promise<
  { success: true; data: Issue } | { success: false; error: string }
> {
  try {
    const octokit = await getRepositoryOctokit({ userId, owner, repo });

    const { data } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    if (data.locked) {
      return { success: false, error: 'Issue is locked' };
    }

    if (data.pull_request) {
      return { success: false, error: 'Issue is a pull request' };
    }

    return { success: true, data };
  } catch (error) {
    console.error(
      `[getIssue] ${error instanceof Error ? error.message : String(error)}`,
    );

    if (error instanceof Error && 'status' in error) {
      if (error.status === 404) {
        return { success: false, error: 'Issue not found' };
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch issue',
    };
  }
}

/**
 * Issue Reactions
 *
 * https://octokit.github.io/rest.js/v22/#reactions-create-for-issue
 */

type CreateIssueReaction = Reactions['createForIssue'];

export async function createReaction(
  token: string,
  params: CreateIssueReaction['parameters'],
): Promise<CreateIssueReaction['response']> {
  return getOctokit(token).rest.reactions.createForIssue(params);
}

type DeleteIssueReaction = Reactions['deleteForIssue'];

export function deleteReaction(
  token: string,
  params: DeleteIssueReaction['parameters'],
): Promise<DeleteIssueReaction['response']> {
  return getOctokit(token).rest.reactions.deleteForIssue(params);
}

/**
 * Issue Comments
 *
 * https://octokit.github.io/rest.js/v22/#issues-create-comment
 */

export async function getIssueComment({
  userId,
  owner,
  repo,
  commentId: comment_id,
}: {
  userId: string;
  owner: string;
  repo: string;
  commentId: number;
}): Promise<IssueComment> {
  const octokit = await getRepositoryOctokit({ userId, owner, repo });

  const { data } = await octokit.rest.issues.getComment({
    owner,
    repo,
    comment_id,
  });

  return data;
}

type CreateIssueComment = Issues['createComment'];

export function createIssueComment(
  token: string,
  params: CreateIssueComment['parameters'],
): Promise<CreateIssueComment['response']> {
  return getOctokit(token).issues.createComment(params);
}

type UpdateIssueComment = Issues['updateComment'];

export function updateIssueComment(
  token: string,
  params: UpdateIssueComment['parameters'],
): Promise<UpdateIssueComment['response']> {
  return getOctokit(token).issues.updateComment(params);
}

/**
 * Review Comments
 *
 * https://octokit.github.io/rest.js/v22/#pulls-create-review-comment
 */

export async function getReviewComments({
  userId,
  owner,
  repo,
  prNumber: pull_number,
}: {
  userId: string;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<ReviewComment[]> {
  const octokit = await getRepositoryOctokit({ userId, owner, repo });

  const { data } = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number,
  });

  return data;
}

type ListReviewComments = Pulls['listReviewComments'];

export async function listReviewComments(
  token: string,
  params: ListReviewComments['parameters'],
): Promise<ReviewComment[]> {
  const octokit = getOctokit(token);

  return octokit.paginate(octokit.pulls.listReviewComments, {
    ...params,
    per_page: 100,
  });
}

type CreateReviewComment = Pulls['createReviewComment'];

export function createReviewComment(
  token: string,
  params: CreateReviewComment['parameters'],
): Promise<CreateReviewComment['response']> {
  return getOctokit(token).pulls.createReviewComment(params);
}

type UpdateReviewComment = Pulls['updateReviewComment'];

export function updateReviewComment(
  token: string,
  params: UpdateReviewComment['parameters'],
): Promise<UpdateReviewComment['response']> {
  return getOctokit(token).pulls.updateReviewComment(params);
}

/**
 * Checks
 */

type CreateCheck = Checks['create'];

export async function createCheckRun(
  token: string,
  params: CreateCheck['parameters'],
): Promise<CreateCheck['response']> {
  return getOctokit(token).rest.checks.create(params);
}

type UpdateCheck = Checks['update'];

export async function updateCheckRun(
  token: string,
  params: UpdateCheck['parameters'],
): Promise<UpdateCheck['response']> {
  return getOctokit(token).rest.checks.update(params);
}

/**
 * Organization Members
 */

async function getOrganizationMembersCount(
  installationId: number,
  accountLogin: string,
): Promise<number | null> {
  try {
    const octokit = await getInstallationOctokit({ installationId });

    const members = await paginate(
      async (page, perPage) => {
        const { data } = await octokit.rest.orgs.listMembers({
          org: accountLogin,
          per_page: perPage,
          page,
        });

        return data;
      },
      { perPage: 100 },
    );

    return members.length;
  } catch (error) {
    console.error(
      `[getOrganizationMembersCount] Failed to fetch members for org ${accountLogin}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return null;
  }
}

/**
 * Repository Content
 */

export async function getContent({
  userId,
  owner,
  repo,
  path,
  ref,
}: {
  userId: string;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<string | null> {
  try {
    const octokit = await getRepositoryOctokit({ userId, owner, repo });

    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if ('content' in data && data.type === 'file') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }

    return null;
  } catch (error) {
    console.error(
      `[getContent] Failed to fetch ${path} from ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return null;
  }
}

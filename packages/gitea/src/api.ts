import { z } from 'zod';

import {
  ALL_REPOSITORIES,
  buildRepositoryCloneUrl,
  type SourceControlProvider,
} from '@roomote/types';
import {
  type TaskRun,
  db,
  environments,
  repositories,
  and,
  eq,
  inArray,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';
import { getGiteaOAuthConnection, resolveGiteaOAuthAccessToken } from './oauth';

const GITEA_PROVIDER = 'gitea' satisfies SourceControlProvider;
const GITEA_REPOSITORIES_PER_PAGE = 50;
const GITEA_WEBHOOK_ENSURE_CONCURRENCY = 5;

const GITEA_WEBHOOK_EVENTS = [
  'pull_request',
  'pull_request_sync',
  'pull_request_comment',
  'issue_comment',
] as const;

const giteaRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable().optional(),
  private: z.boolean().optional(),
  default_branch: z.string().nullable().optional(),
  clone_url: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  permissions: z.unknown().optional(),
});

const giteaRepositoryListSchema = z.array(giteaRepositorySchema);
const giteaUserSchema = z.object({
  id: z.number().optional(),
  login: z.string().min(1),
});
const giteaIssueCommentSchema = z.object({
  id: z.number(),
});
const giteaHookSchema = z
  .object({
    id: z.number(),
    type: z.string().optional(),
    config: z.record(z.string()).optional(),
  })
  .passthrough();
const giteaHookListSchema = z.array(giteaHookSchema);

export type GiteaRepository = z.infer<typeof giteaRepositorySchema>;
export type GiteaCurrentUser = z.infer<typeof giteaUserSchema>;
export type GiteaRepositoryCredential = {
  host: string;
  repositoryFullName: string;
  username: string;
  token: string;
  originBaseUrl: string;
};

export type GiteaRepositoryValues = {
  sourceControlProvider: typeof GITEA_PROVIDER;
  installationId: null;
  userId: null;
  githubRepoId: null;
  externalRepoId: string;
  host: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  permissions: Record<string, unknown>;
  isActive: true;
  linkedByUserId: string;
};

export type ListGiteaRepositoriesOptions = {
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  stopAfter?: number;
};

export type GiteaWebhookEnsureResult = {
  repositoryFullName: string;
  status: 'created' | 'updated' | 'failed';
  error?: string;
};

export function normalizeGiteaBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');

  if (!trimmed) {
    throw new Error('GITEA_BASE_URL cannot be empty.');
  }

  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
  const apiPathSuffix = /\/api\/v1$/;

  if (url.hostname === 'gitea.com') {
    url.pathname = '/';
  } else if (apiPathSuffix.test(url.pathname)) {
    url.pathname = url.pathname.replace(apiPathSuffix, '') || '/';
  }

  return url.toString().replace(/\/+$/, '');
}

export async function resolveGiteaToken(): Promise<string | null> {
  return resolveGiteaOAuthAccessToken();
}

let cachedGiteaDeploymentUser: {
  token: string;
  baseUrl: string;
  user: GiteaCurrentUser;
} | null = null;

export async function resolveGiteaBaseUrl(): Promise<string | null> {
  const baseUrl = await resolveDeploymentEnvVar('GITEA_BASE_URL');
  return baseUrl ? normalizeGiteaBaseUrl(baseUrl) : null;
}

export async function resolveGiteaUsername(): Promise<string | null> {
  return (await getGiteaOAuthConnection())?.username || null;
}

export function buildGiteaApiBaseUrl(baseUrl: string): string {
  return new URL('api/v1', `${normalizeGiteaBaseUrl(baseUrl)}/`).toString();
}

function buildGiteaApiUrl(
  apiBaseUrl: string,
  path: string,
  params: Record<string, string | number | boolean>,
): string {
  const url = new URL(
    path.replace(/^\//, ''),
    `${apiBaseUrl.replace(/\/$/, '')}/`,
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

async function requestGiteaJson<T>({
  apiBaseUrl,
  fetchImpl = fetch,
  method = 'GET',
  path,
  params,
  token,
  body,
  schema,
}: {
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  method?: 'GET' | 'POST' | 'PATCH';
  path: string;
  params: Record<string, string | number | boolean>;
  token: string;
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
}): Promise<{ data: T; response: Response }> {
  const response = await fetchImpl(buildGiteaApiUrl(apiBaseUrl, path, params), {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (![200, 201].includes(response.status)) {
    throw new GiteaApiError(response.status, response.statusText);
  }

  return {
    data: schema.parse(await response.json()),
    response,
  };
}

function parseTotalCount(response: Response): number | null {
  const totalCount = response.headers.get('x-total-count');

  if (!totalCount) {
    return null;
  }

  const parsed = Number(totalCount);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function hasNextLink(response: Response): boolean {
  const link = response.headers.get('link');
  return Boolean(link && /\brel="?next"?/i.test(link));
}

export class GiteaApiError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`Gitea API request failed: ${status} ${statusText}`);
    this.name = 'GiteaApiError';
    this.status = status;
  }
}

export async function listGiteaRepositories({
  token,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
  stopAfter,
}: ListGiteaRepositoriesOptions = {}): Promise<GiteaRepository[]> {
  const giteaToken = token ?? (await resolveGiteaToken());

  if (!giteaToken?.trim()) {
    throw new Error('Gitea OAuth connection is required to sync repositories.');
  }

  const resolvedBaseUrl = baseUrl ?? (await resolveGiteaBaseUrl());

  if (!resolvedBaseUrl?.trim() && !apiBaseUrl?.trim()) {
    throw new Error('GITEA_BASE_URL is required to sync Gitea repositories.');
  }

  const resolvedApiBaseUrl =
    apiBaseUrl ?? buildGiteaApiBaseUrl(resolvedBaseUrl!);
  const repositoriesList: GiteaRepository[] = [];
  let page = 1;

  while (true) {
    const { data, response } = await requestGiteaJson({
      apiBaseUrl: resolvedApiBaseUrl,
      fetchImpl,
      path: '/user/repos',
      params: {
        limit: GITEA_REPOSITORIES_PER_PAGE,
        page,
      },
      token: giteaToken,
      schema: giteaRepositoryListSchema,
    });

    repositoriesList.push(...data);

    if (stopAfter !== undefined && repositoriesList.length >= stopAfter) {
      return repositoriesList.slice(0, stopAfter);
    }

    const totalCount = parseTotalCount(response);

    if (totalCount !== null) {
      if (repositoriesList.length >= totalCount) {
        break;
      }
    } else if (!hasNextLink(response)) {
      break;
    }

    page += 1;
  }

  return repositoriesList;
}

function hostFromBaseUrl(baseUrl: string): string {
  return new URL(normalizeGiteaBaseUrl(baseUrl)).host;
}

function buildGiteaWebUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ''), `${normalizeGiteaBaseUrl(baseUrl)}/`)
    .toString()
    .replace(/\/+$/, '');
}

export function buildGiteaRepositoryValues({
  repository,
  linkedByUserId,
  baseUrl,
}: {
  repository: GiteaRepository;
  linkedByUserId: string;
  baseUrl: string;
}): GiteaRepositoryValues {
  const fullName = repository.full_name;
  const host = hostFromBaseUrl(baseUrl);

  return {
    sourceControlProvider: GITEA_PROVIDER,
    installationId: null,
    userId: null,
    githubRepoId: null,
    externalRepoId: String(repository.id),
    host,
    name: repository.name,
    fullName,
    description: repository.description ?? null,
    private: repository.private ?? true,
    defaultBranch: repository.default_branch ?? 'main',
    cloneUrl:
      repository.clone_url ??
      buildRepositoryCloneUrl({
        provider: GITEA_PROVIDER,
        host,
        repositoryFullName: fullName,
      }),
    htmlUrl: repository.html_url ?? buildGiteaWebUrl(baseUrl, fullName),
    permissions:
      repository.permissions && typeof repository.permissions === 'object'
        ? (repository.permissions as Record<string, unknown>)
        : {},
    isActive: true,
    linkedByUserId,
  };
}

export async function syncGiteaRepositories({
  userId,
  token,
  baseUrl,
  repositories: giteaRepositories,
  fetchImpl,
}: {
  userId: string;
  token?: string;
  baseUrl?: string;
  repositories?: GiteaRepository[];
  fetchImpl?: typeof fetch;
}) {
  const resolvedBaseUrl = baseUrl ?? (await resolveGiteaBaseUrl());

  if (!resolvedBaseUrl?.trim()) {
    throw new Error('GITEA_BASE_URL is required to sync Gitea repositories.');
  }

  const existingIds = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.sourceControlProvider, GITEA_PROVIDER),
          eq(repositories.isActive, true),
        ),
      )
  ).map((repository) => repository.id);

  const repositoriesToSync =
    giteaRepositories ??
    (await listGiteaRepositories({
      token,
      baseUrl: resolvedBaseUrl,
      fetchImpl,
    }));

  const syncedRepositories = [];

  for (const repository of repositoriesToSync) {
    const values = buildGiteaRepositoryValues({
      repository,
      linkedByUserId: userId,
      baseUrl: resolvedBaseUrl,
    });

    const findExistingRepository = () =>
      db.query.repositories.findFirst({
        where: and(
          eq(repositories.sourceControlProvider, GITEA_PROVIDER),
          eq(repositories.externalRepoId, values.externalRepoId),
        ),
      });

    const existingRepository = await findExistingRepository();

    if (existingRepository) {
      await db
        .update(repositories)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(repositories.id, existingRepository.id));
    } else {
      await db.insert(repositories).values(values);
    }

    const syncedRepository = await findExistingRepository();

    if (syncedRepository) {
      syncedRepositories.push(syncedRepository);
    }
  }

  const syncedIds = new Set(
    syncedRepositories.map((repository) => repository.id),
  );
  const missingIds = existingIds.filter((id) => !syncedIds.has(id));

  if (missingIds.length > 0) {
    await db
      .update(repositories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(repositories.id, missingIds));
  }

  return {
    success: true as const,
    repositories: syncedRepositories,
  };
}

function normalizeRepositorySelection(repositoryNames: string[]): string[] {
  return [...new Set(repositoryNames.filter(Boolean))];
}

async function resolveGiteaRepositoryNamesForTaskRun(
  taskRun: TaskRun,
): Promise<string[] | null> {
  if (taskRun.payload.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, taskRun.payload.environmentId),
    });

    if (!environment) {
      throw new Error(
        `Environment not found for task run ${taskRun.id}: ${taskRun.payload.environmentId}`,
      );
    }

    return normalizeRepositorySelection(
      environment.config.repositories.map(
        (repository) => repository.repository,
      ),
    );
  }

  if (Array.isArray(taskRun.payload.selectedRepositories)) {
    const selectedRepositories = normalizeRepositorySelection(
      taskRun.payload.selectedRepositories,
    );

    if (selectedRepositories.length > 0) {
      return selectedRepositories;
    }
  }

  if (taskRun.payload.repo && taskRun.payload.repo !== ALL_REPOSITORIES) {
    return [taskRun.payload.repo];
  }

  return null;
}

async function resolveGiteaRepositoryRowsForTaskRun(taskRun: TaskRun) {
  const repositoryNames = await resolveGiteaRepositoryNamesForTaskRun(taskRun);
  const queryConditions = [
    eq(repositories.sourceControlProvider, GITEA_PROVIDER),
    eq(repositories.isActive, true),
  ];

  if (repositoryNames !== null) {
    queryConditions.push(inArray(repositories.fullName, repositoryNames));
  }

  const repositoryRows = await db.query.repositories.findMany({
    where: and(...queryConditions),
    columns: {
      fullName: true,
    },
  });

  if (repositoryNames === null) {
    if (repositoryRows.length === 0) {
      throw new Error(
        `No synced Gitea repositories found for task run ${taskRun.id}.`,
      );
    }

    return repositoryRows;
  }

  const repositoryByName = new Map(
    repositoryRows.map((repository) => [repository.fullName, repository]),
  );
  const missingRepositories = repositoryNames.filter(
    (repositoryName) => !repositoryByName.has(repositoryName),
  );

  if (missingRepositories.length > 0) {
    throw new Error(
      `Selected Gitea repositories not found for task run ${taskRun.id}: ${missingRepositories.join(', ')}`,
    );
  }

  return repositoryNames.map((repositoryName) => {
    const repository = repositoryByName.get(repositoryName);

    if (!repository) {
      throw new Error(`Gitea repository ${repositoryName} is missing.`);
    }

    return repository;
  });
}

export async function getGiteaAuthenticatedUser({
  token,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
}: {
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ login: string }> {
  const giteaToken = token ?? (await resolveGiteaToken());

  if (!giteaToken?.trim()) {
    throw new Error(
      'Gitea OAuth connection is required for source control jobs.',
    );
  }

  const resolvedBaseUrl = baseUrl ?? (await resolveGiteaBaseUrl());

  if (!resolvedBaseUrl?.trim() && !apiBaseUrl?.trim()) {
    throw new Error(
      'GITEA_BASE_URL is required for Gitea source control jobs.',
    );
  }

  const { data } = await requestGiteaJson({
    apiBaseUrl: apiBaseUrl ?? buildGiteaApiBaseUrl(resolvedBaseUrl!),
    fetchImpl,
    path: '/user',
    params: {},
    token: giteaToken,
    schema: giteaUserSchema,
  });

  return data;
}

export async function getGiteaDeploymentUser(options?: {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GiteaCurrentUser | null> {
  const token = await resolveGiteaToken();

  if (!token?.trim()) {
    return null;
  }

  const baseUrl = await resolveGiteaBaseUrl();

  if (!baseUrl?.trim() && !options?.apiBaseUrl?.trim()) {
    return null;
  }

  const cacheBaseUrl = options?.apiBaseUrl ?? baseUrl ?? '';

  if (
    cachedGiteaDeploymentUser?.token === token &&
    cachedGiteaDeploymentUser.baseUrl === cacheBaseUrl
  ) {
    return cachedGiteaDeploymentUser.user;
  }

  const user = await getGiteaAuthenticatedUser({
    token,
    baseUrl: baseUrl ?? undefined,
    apiBaseUrl: options?.apiBaseUrl,
    fetchImpl: options?.fetchImpl,
  });

  cachedGiteaDeploymentUser = {
    token,
    baseUrl: cacheBaseUrl,
    user,
  };

  return user;
}

export function clearGiteaDeploymentUserCache(): void {
  cachedGiteaDeploymentUser = null;
}

function splitGiteaRepositoryFullName(repositoryFullName: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo, ...extraParts] = repositoryFullName.split('/');

  if (!owner || !repo || extraParts.length > 0) {
    throw new Error(
      `Gitea repository full name must be in owner/repo format: ${repositoryFullName}`,
    );
  }

  return { owner, repo };
}

export async function createGiteaPullRequestComment({
  repositoryFullName,
  pullRequestNumber,
  body,
  token,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  body: string;
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: number }> {
  const giteaToken = token ?? (await resolveGiteaToken());

  if (!giteaToken?.trim()) {
    throw new Error(
      'Gitea OAuth connection is required to create pull request comments.',
    );
  }

  const resolvedBaseUrl = baseUrl ?? (await resolveGiteaBaseUrl());

  if (!resolvedBaseUrl?.trim() && !apiBaseUrl?.trim()) {
    throw new Error(
      'GITEA_BASE_URL is required to create Gitea pull request comments.',
    );
  }

  const { owner, repo } = splitGiteaRepositoryFullName(repositoryFullName);
  const { data } = await requestGiteaJson({
    apiBaseUrl: apiBaseUrl ?? buildGiteaApiBaseUrl(resolvedBaseUrl!),
    fetchImpl,
    method: 'POST',
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/issues/${pullRequestNumber}/comments`,
    params: {},
    token: giteaToken,
    body: { body },
    schema: giteaIssueCommentSchema,
  });

  return data;
}

async function findGiteaRepositoryWebhookByUrl({
  owner,
  repo,
  webhookUrl,
  token,
  apiBaseUrl,
  fetchImpl,
}: {
  owner: string;
  repo: string;
  webhookUrl: string;
  token: string;
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<z.infer<typeof giteaHookSchema> | undefined> {
  const hooks: z.infer<typeof giteaHookSchema>[] = [];
  let page = 1;

  while (true) {
    const { data, response } = await requestGiteaJson({
      apiBaseUrl,
      fetchImpl,
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}/hooks`,
      params: { limit: 100, page },
      token,
      schema: giteaHookListSchema,
    });

    hooks.push(...data);

    const totalCount = parseTotalCount(response);

    if (totalCount !== null) {
      if (hooks.length >= totalCount) {
        break;
      }
    } else if (!hasNextLink(response)) {
      break;
    }

    page += 1;
  }

  return hooks.find(
    (hook) => hook.type === 'gitea' && hook.config?.url === webhookUrl,
  );
}

async function ensureGiteaRepositoryWebhook({
  repositoryFullName,
  webhookUrl,
  secretToken,
  token,
  apiBaseUrl,
  fetchImpl,
}: {
  repositoryFullName: string;
  webhookUrl: string;
  secretToken: string;
  token: string;
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const { owner, repo } = splitGiteaRepositoryFullName(repositoryFullName);
  const existingHook = await findGiteaRepositoryWebhookByUrl({
    owner,
    repo,
    webhookUrl,
    token,
    apiBaseUrl,
    fetchImpl,
  });
  const config = {
    url: webhookUrl,
    content_type: 'json',
    secret: secretToken,
    http_method: 'post',
  };
  const body = {
    name: 'Roomote',
    config,
    events: [...GITEA_WEBHOOK_EVENTS],
    active: true,
  };

  if (!existingHook) {
    await requestGiteaJson({
      apiBaseUrl,
      fetchImpl,
      method: 'POST',
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}/hooks`,
      params: {},
      token,
      body: {
        type: 'gitea',
        ...body,
      },
      schema: giteaHookSchema,
    });

    return 'created';
  }

  await requestGiteaJson({
    apiBaseUrl,
    fetchImpl,
    method: 'PATCH',
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/hooks/${existingHook.id}`,
    params: {},
    token,
    body,
    schema: giteaHookSchema,
  });

  return 'updated';
}

export async function ensureGiteaWebhooksForRepositories({
  repositories,
  webhookUrl,
  secretToken,
  token,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
}: {
  repositories: { repositoryFullName: string }[];
  webhookUrl: string;
  secretToken: string;
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GiteaWebhookEnsureResult[]> {
  const giteaToken = token ?? (await resolveGiteaToken());

  if (!giteaToken?.trim()) {
    throw new Error(
      'Gitea OAuth connection is required to configure webhooks.',
    );
  }

  const resolvedBaseUrl = baseUrl ?? (await resolveGiteaBaseUrl());

  if (!resolvedBaseUrl?.trim() && !apiBaseUrl?.trim()) {
    throw new Error('GITEA_BASE_URL is required to configure Gitea webhooks.');
  }

  const resolvedApiBaseUrl =
    apiBaseUrl ?? buildGiteaApiBaseUrl(resolvedBaseUrl!);
  const results: GiteaWebhookEnsureResult[] = [];

  for (
    let index = 0;
    index < repositories.length;
    index += GITEA_WEBHOOK_ENSURE_CONCURRENCY
  ) {
    const chunk = repositories.slice(
      index,
      index + GITEA_WEBHOOK_ENSURE_CONCURRENCY,
    );

    results.push(
      ...(await Promise.all(
        chunk.map(
          async (repository): Promise<GiteaWebhookEnsureResult> =>
            ensureGiteaRepositoryWebhook({
              repositoryFullName: repository.repositoryFullName,
              webhookUrl,
              secretToken,
              token: giteaToken,
              apiBaseUrl: resolvedApiBaseUrl,
              fetchImpl,
            })
              .then((status) => ({
                repositoryFullName: repository.repositoryFullName,
                status,
              }))
              .catch((error: unknown) => ({
                repositoryFullName: repository.repositoryFullName,
                status: 'failed' as const,
                error: error instanceof Error ? error.message : String(error),
              })),
        ),
      )),
    );
  }

  return results;
}

export type GiteaWebhookRemoveResult = {
  repositoryFullName: string;
  status: 'removed' | 'not_found' | 'failed';
  error?: string;
};

async function removeGiteaRepositoryWebhook({
  repositoryFullName,
  webhookUrl,
  token,
  apiBaseUrl,
  fetchImpl = fetch,
}: {
  repositoryFullName: string;
  webhookUrl: string;
  token: string;
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<'removed' | 'not_found'> {
  const { owner, repo } = splitGiteaRepositoryFullName(repositoryFullName);
  const existingHook = await findGiteaRepositoryWebhookByUrl({
    owner,
    repo,
    webhookUrl,
    token,
    apiBaseUrl,
    fetchImpl,
  });

  if (!existingHook) {
    return 'not_found';
  }

  const response = await fetchImpl(
    buildGiteaApiUrl(
      apiBaseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}/hooks/${existingHook.id}`,
      {},
    ),
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (![200, 204, 404].includes(response.status)) {
    throw new GiteaApiError(response.status, response.statusText);
  }

  return 'removed';
}

/**
 * Removes the Roomote webhook (matched by exact webhook URL) from each
 * repository. Sync uses this to keep webhooks scoped to repositories the
 * deployment actually uses: synced repositories without an environment
 * mapping get their Roomote hook removed instead of refreshed. Failures are
 * collected per repository instead of failing the whole batch.
 */
export async function removeGiteaWebhooksForRepositories({
  repositories,
  webhookUrl,
  token,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
}: {
  repositories: { repositoryFullName: string }[];
  webhookUrl: string;
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GiteaWebhookRemoveResult[]> {
  const giteaToken = token ?? (await resolveGiteaToken());

  if (!giteaToken?.trim()) {
    throw new Error(
      'Gitea OAuth connection is required to configure webhooks.',
    );
  }

  const resolvedBaseUrl = baseUrl ?? (await resolveGiteaBaseUrl());

  if (!resolvedBaseUrl?.trim() && !apiBaseUrl?.trim()) {
    throw new Error('GITEA_BASE_URL is required to configure Gitea webhooks.');
  }

  const resolvedApiBaseUrl =
    apiBaseUrl ?? buildGiteaApiBaseUrl(resolvedBaseUrl!);
  const results: GiteaWebhookRemoveResult[] = [];

  for (
    let index = 0;
    index < repositories.length;
    index += GITEA_WEBHOOK_ENSURE_CONCURRENCY
  ) {
    const chunk = repositories.slice(
      index,
      index + GITEA_WEBHOOK_ENSURE_CONCURRENCY,
    );

    results.push(
      ...(await Promise.all(
        chunk.map(
          async (repository): Promise<GiteaWebhookRemoveResult> =>
            removeGiteaRepositoryWebhook({
              repositoryFullName: repository.repositoryFullName,
              webhookUrl,
              token: giteaToken,
              apiBaseUrl: resolvedApiBaseUrl,
              fetchImpl,
            })
              .then((status) => ({
                repositoryFullName: repository.repositoryFullName,
                status,
              }))
              .catch((error: unknown) => ({
                repositoryFullName: repository.repositoryFullName,
                status: 'failed' as const,
                error: error instanceof Error ? error.message : String(error),
              })),
        ),
      )),
    );
  }

  return results;
}

export async function createTaskRunGiteaCredentials(
  taskRun: TaskRun,
  options?: {
    fetchImpl?: typeof fetch;
    token?: string;
    baseUrl?: string;
    username?: string;
  },
): Promise<{
  credentials: GiteaRepositoryCredential[];
}> {
  const deploymentToken = options?.token ?? (await resolveGiteaToken());

  if (!deploymentToken?.trim()) {
    throw new Error(
      'Gitea OAuth connection is required for source control jobs.',
    );
  }

  const baseUrl = options?.baseUrl ?? (await resolveGiteaBaseUrl());

  if (!baseUrl?.trim()) {
    throw new Error(
      'GITEA_BASE_URL is required for Gitea source control jobs.',
    );
  }

  const username =
    options?.username ??
    (await resolveGiteaUsername()) ??
    (
      await getGiteaAuthenticatedUser({
        token: deploymentToken,
        baseUrl,
        fetchImpl: options?.fetchImpl,
      })
    ).login;
  const host = hostFromBaseUrl(baseUrl);
  const repositoriesList = await resolveGiteaRepositoryRowsForTaskRun(taskRun);

  return {
    credentials: repositoriesList.map((repository) => ({
      host,
      repositoryFullName: repository.fullName,
      username,
      token: deploymentToken,
      originBaseUrl: baseUrl,
    })),
  };
}

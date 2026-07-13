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

const GITLAB_PROVIDER = 'gitlab' satisfies SourceControlProvider;
const DEFAULT_GITLAB_BASE_URL = 'https://gitlab.com';
const GITLAB_PROJECTS_PER_PAGE = 100;
const GITLAB_SCOPED_PROJECT_TOKEN_ACCESS_LEVEL_DEVELOPER = 30;
const GITLAB_SCOPED_PROJECT_TOKEN_SCOPES = [
  'read_repository',
  'write_repository',
] as const;
const GITLAB_SCOPED_PROJECT_TOKEN_TTL_DAYS = 1;

export const GITLAB_SCOPED_PROJECT_TOKENS_ARTIFACT_KEY =
  'gitlabScopedProjectTokens';

const gitLabProjectSchema = z.object({
  id: z.number(),
  name: z.string(),
  path_with_namespace: z.string(),
  description: z.string().nullable().optional(),
  visibility: z.string().optional(),
  default_branch: z.string().nullable().optional(),
  http_url_to_repo: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
  permissions: z.unknown().optional(),
});

const gitLabProjectListSchema = z.array(gitLabProjectSchema);
const gitLabUserSchema = z.object({
  id: z.number(),
  username: z.string(),
});
const gitLabMergeRequestNoteSchema = z.object({
  id: z.number(),
});
const gitLabProjectHookSchema = z.object({
  id: z.number(),
  url: z.string(),
});
const gitLabProjectHookListSchema = z.array(gitLabProjectHookSchema);
const gitLabProjectAccessTokenSchema = z.object({
  id: z.number(),
  token: z.string(),
  username: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
});
const gitLabScopedProjectTokenDescriptorSchema = z.object({
  repositoryFullName: z.string().min(1),
  projectId: z.string().min(1),
  tokenId: z.number().int().positive(),
});
const gitLabScopedProjectTokenDescriptorListSchema = z.array(
  gitLabScopedProjectTokenDescriptorSchema,
);

export type GitLabProject = z.infer<typeof gitLabProjectSchema>;
export type GitLabCurrentUser = z.infer<typeof gitLabUserSchema>;
export type GitLabScopedProjectTokenDescriptor = z.infer<
  typeof gitLabScopedProjectTokenDescriptorSchema
>;
export type GitLabScopedProjectTokenCredential = {
  host: string;
  repositoryFullName: string;
  username: string;
  token: string;
};

export type GitLabRepositoryValues = {
  sourceControlProvider: typeof GITLAB_PROVIDER;
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

export type ListGitLabProjectsOptions = {
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  stopAfter?: number;
};

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');

  if (!trimmed) {
    throw new Error('R_GITLAB_BASE_URL cannot be empty.');
  }

  return new URL(trimmed).toString().replace(/\/+$/, '');
}

export async function resolveGitLabToken(): Promise<string | null> {
  return resolveDeploymentEnvVar('GITLAB_TOKEN');
}

let cachedGitLabDeploymentUser: {
  token: string;
  user: GitLabCurrentUser;
} | null = null;

/**
 * Resolves the GitLab identity behind the deployment token via `GET /user`.
 * The result is cached per token value so webhook handlers can call this on
 * every delivery without re-hitting the GitLab API.
 */
export async function getGitLabDeploymentUser(options?: {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitLabCurrentUser | null> {
  const token = await resolveGitLabToken();

  if (!token?.trim()) {
    return null;
  }

  if (cachedGitLabDeploymentUser?.token === token) {
    return cachedGitLabDeploymentUser.user;
  }

  const { data } = await requestGitLabJson({
    apiBaseUrl: options?.apiBaseUrl,
    fetchImpl: options?.fetchImpl,
    path: '/user',
    params: {},
    token,
    schema: gitLabUserSchema,
  });

  cachedGitLabDeploymentUser = { token, user: data };

  return data;
}

export function clearGitLabDeploymentUserCache(): void {
  cachedGitLabDeploymentUser = null;
}

export async function createGitLabMergeRequestNote({
  projectId,
  mergeRequestIid,
  body,
  token,
  apiBaseUrl,
  fetchImpl,
}: {
  projectId: string | number;
  mergeRequestIid: number;
  body: string;
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: number }> {
  const gitLabToken = token ?? (await resolveGitLabToken());

  if (!gitLabToken?.trim()) {
    throw new Error(
      'GITLAB_TOKEN is required to create GitLab merge request notes.',
    );
  }

  const { data } = await requestGitLabJson({
    apiBaseUrl,
    fetchImpl,
    method: 'POST',
    path: `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/notes`,
    params: {},
    token: gitLabToken,
    body: { body },
    schema: gitLabMergeRequestNoteSchema,
  });

  return data;
}

export async function resolveGitLabBaseUrl(): Promise<string> {
  const baseUrl = await resolveDeploymentEnvVar('R_GITLAB_BASE_URL');
  return normalizeBaseUrl(baseUrl ?? DEFAULT_GITLAB_BASE_URL);
}

export function buildGitLabApiBaseUrl(baseUrl: string): string {
  return new URL('api/v4', `${normalizeBaseUrl(baseUrl)}/`).toString();
}

function hostFromBaseUrl(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl)).host;
}

function buildGitLabWebUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ''), `${normalizeBaseUrl(baseUrl)}/`)
    .toString()
    .replace(/\/+$/, '');
}

export class GitLabApiError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`GitLab API request failed: ${status} ${statusText}`);
    this.name = 'GitLabApiError';
    this.status = status;
  }
}

/**
 * GitLab responds with 400 ("User does not have permission to create project
 * access token"), 403, or 404 when the deployment token cannot mint scoped
 * project tokens — most commonly on gitlab.com Free-tier namespaces, where
 * project access tokens require a Premium or Ultimate subscription.
 * 401 is deliberately excluded: it means the deployment token itself failed
 * to authenticate, and falling back would just route the same bad token to
 * git clones and mask the misconfiguration.
 */
export function isGitLabPermissionError(error: unknown): boolean {
  return (
    error instanceof GitLabApiError && [400, 403, 404].includes(error.status)
  );
}

function buildGitLabApiUrl(
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

async function requestGitLab(
  {
    apiBaseUrl,
    fetchImpl = fetch,
    method = 'GET',
    path,
    params,
    token,
    body,
  }: {
    apiBaseUrl?: string;
    fetchImpl?: typeof fetch;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    params?: Record<string, string | number | boolean>;
    token: string;
    body?: Record<string, unknown>;
  },
  expectedStatuses: number[],
): Promise<Response> {
  const resolvedApiBaseUrl =
    apiBaseUrl ?? buildGitLabApiBaseUrl(await resolveGitLabBaseUrl());
  const response = await fetchImpl(
    buildGitLabApiUrl(resolvedApiBaseUrl, path, params ?? {}),
    {
      method,
      headers: {
        Accept: 'application/json',
        'PRIVATE-TOKEN': token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  if (!expectedStatuses.includes(response.status)) {
    throw new GitLabApiError(response.status, response.statusText);
  }

  return response;
}

async function requestGitLabJson<T>({
  apiBaseUrl,
  fetchImpl = fetch,
  method = 'GET',
  path,
  params,
  token,
  body,
  schema,
}: {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  method?: 'GET' | 'POST' | 'PUT';
  path: string;
  params: Record<string, string | number | boolean>;
  token: string;
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
}): Promise<{ data: T; response: Response }> {
  const response = await requestGitLab(
    {
      apiBaseUrl,
      fetchImpl,
      method,
      path,
      params,
      token,
      body,
    },
    [200, 201],
  );

  return {
    data: schema.parse(await response.json()),
    response,
  };
}

export async function listGitLabProjects({
  token,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
  stopAfter,
}: ListGitLabProjectsOptions = {}): Promise<GitLabProject[]> {
  const gitLabToken = token ?? (await resolveGitLabToken());

  if (!gitLabToken?.trim()) {
    throw new Error('GITLAB_TOKEN is required to sync GitLab repositories.');
  }

  const resolvedApiBaseUrl =
    apiBaseUrl ??
    buildGitLabApiBaseUrl(baseUrl ?? (await resolveGitLabBaseUrl()));
  const projects: GitLabProject[] = [];
  let page = 1;

  while (true) {
    const { data, response } = await requestGitLabJson({
      apiBaseUrl: resolvedApiBaseUrl,
      fetchImpl,
      path: '/projects',
      method: 'GET',
      params: {
        membership: true,
        simple: true,
        archived: false,
        order_by: 'path',
        sort: 'asc',
        per_page: GITLAB_PROJECTS_PER_PAGE,
        page,
      },
      token: gitLabToken,
      schema: gitLabProjectListSchema,
    });

    projects.push(...data);

    if (stopAfter !== undefined && projects.length >= stopAfter) {
      return projects.slice(0, stopAfter);
    }

    const nextPage = response.headers.get('x-next-page');

    if (!nextPage) {
      break;
    }

    page = Number(nextPage);

    if (!Number.isInteger(page) || page < 1) {
      break;
    }
  }

  return projects;
}

export type GitLabTokenValidationResult =
  | { status: 'valid'; username: string }
  | { status: 'invalid'; error: string }
  | { status: 'unknown'; error: string };

const GITLAB_TOKEN_VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Verifies that a GitLab token can authenticate against the GitLab API.
 * Returns `invalid` only for definitive auth failures so transient network
 * or GitLab availability issues do not block saving configuration. The
 * request is bounded by a timeout so callers are never held open by a slow
 * GitLab response.
 */
export async function validateGitLabToken({
  token,
  apiBaseUrl,
  fetchImpl = fetch,
  timeoutMs = GITLAB_TOKEN_VALIDATION_TIMEOUT_MS,
}: {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<GitLabTokenValidationResult> {
  const timedFetch: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  try {
    const { data } = await requestGitLabJson({
      apiBaseUrl,
      fetchImpl: timedFetch,
      path: '/user',
      params: {},
      token,
      schema: gitLabUserSchema,
    });

    return { status: 'valid', username: data.username };
  } catch (error) {
    if (error instanceof GitLabApiError && [401, 403].includes(error.status)) {
      return {
        status: 'invalid',
        error:
          'GitLab rejected the token. Confirm the token is active and has the api scope.',
      };
    }

    return {
      status: 'unknown',
      error: `Could not verify the GitLab token: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

const GITLAB_WEBHOOK_EVENT_FLAGS = {
  merge_requests_events: true,
  note_events: true,
  push_events: false,
} as const;

const GITLAB_WEBHOOK_ENSURE_CONCURRENCY = 5;

export type GitLabWebhookEnsureResult = {
  repositoryFullName: string;
  status: 'created' | 'updated' | 'failed';
  error?: string;
};

async function findGitLabProjectWebhookByUrl({
  projectId,
  webhookUrl,
  token,
  apiBaseUrl,
  fetchImpl,
}: {
  projectId: string;
  webhookUrl: string;
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<z.infer<typeof gitLabProjectHookSchema> | undefined> {
  let page = 1;

  while (true) {
    const { data: hooks, response } = await requestGitLabJson({
      apiBaseUrl,
      fetchImpl,
      path: `/projects/${encodeURIComponent(projectId)}/hooks`,
      params: { per_page: 100, page },
      token,
      schema: gitLabProjectHookListSchema,
    });

    const match = hooks.find((hook) => hook.url === webhookUrl);

    if (match) {
      return match;
    }

    const nextPage = Number(response.headers.get('x-next-page'));

    if (!Number.isInteger(nextPage) || nextPage <= page) {
      return undefined;
    }

    page = nextPage;
  }
}

async function ensureGitLabProjectWebhook({
  projectId,
  webhookUrl,
  secretToken,
  token,
  apiBaseUrl,
  fetchImpl,
}: {
  projectId: string;
  webhookUrl: string;
  secretToken: string;
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const existingHook = await findGitLabProjectWebhookByUrl({
    projectId,
    webhookUrl,
    token,
    apiBaseUrl,
    fetchImpl,
  });
  const body = {
    url: webhookUrl,
    token: secretToken,
    enable_ssl_verification: true,
    ...GITLAB_WEBHOOK_EVENT_FLAGS,
  };

  if (!existingHook) {
    await requestGitLabJson({
      apiBaseUrl,
      fetchImpl,
      method: 'POST',
      path: `/projects/${encodeURIComponent(projectId)}/hooks`,
      params: {},
      token,
      body,
      schema: gitLabProjectHookSchema,
    });

    return 'created';
  }

  await requestGitLabJson({
    apiBaseUrl,
    fetchImpl,
    method: 'PUT',
    path: `/projects/${encodeURIComponent(projectId)}/hooks/${existingHook.id}`,
    params: {},
    token,
    body,
    schema: gitLabProjectHookSchema,
  });

  return 'updated';
}

/**
 * Creates or refreshes the Roomote merge-request webhook on each project.
 * Failures are collected per project (for example when the token identity is
 * not a Maintainer of a project) instead of failing the whole batch.
 */
export async function ensureGitLabWebhooksForProjects({
  projects,
  webhookUrl,
  secretToken,
  token,
  apiBaseUrl,
  fetchImpl,
}: {
  projects: { projectId: string; repositoryFullName: string }[];
  webhookUrl: string;
  secretToken: string;
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitLabWebhookEnsureResult[]> {
  const gitLabToken = token ?? (await resolveGitLabToken());

  if (!gitLabToken?.trim()) {
    throw new Error('GITLAB_TOKEN is required to configure GitLab webhooks.');
  }

  const results: GitLabWebhookEnsureResult[] = [];

  for (
    let index = 0;
    index < projects.length;
    index += GITLAB_WEBHOOK_ENSURE_CONCURRENCY
  ) {
    const chunk = projects.slice(
      index,
      index + GITLAB_WEBHOOK_ENSURE_CONCURRENCY,
    );

    results.push(
      ...(await Promise.all(
        chunk.map(
          async (project): Promise<GitLabWebhookEnsureResult> =>
            ensureGitLabProjectWebhook({
              projectId: project.projectId,
              webhookUrl,
              secretToken,
              token: gitLabToken,
              apiBaseUrl,
              fetchImpl,
            })
              .then((status) => ({
                repositoryFullName: project.repositoryFullName,
                status,
              }))
              .catch((error: unknown) => ({
                repositoryFullName: project.repositoryFullName,
                status: 'failed' as const,
                error: error instanceof Error ? error.message : String(error),
              })),
        ),
      )),
    );
  }

  return results;
}

export type GitLabWebhookRemoveResult = {
  repositoryFullName: string;
  status: 'removed' | 'not_found' | 'failed';
  error?: string;
};

/**
 * Removes the Roomote webhook (matched by exact webhook URL) from each
 * project. Sync uses this to keep webhooks scoped to repositories the
 * deployment actually uses: synced projects without an environment mapping
 * get their Roomote hook removed instead of refreshed. Failures are
 * collected per project instead of failing the whole batch.
 */
export async function removeGitLabWebhooksForProjects({
  projects,
  webhookUrl,
  token,
  apiBaseUrl,
  fetchImpl,
}: {
  projects: { projectId: string; repositoryFullName: string }[];
  webhookUrl: string;
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitLabWebhookRemoveResult[]> {
  const gitLabToken = token ?? (await resolveGitLabToken());

  if (!gitLabToken?.trim()) {
    throw new Error('GITLAB_TOKEN is required to configure GitLab webhooks.');
  }

  const results: GitLabWebhookRemoveResult[] = [];

  for (
    let index = 0;
    index < projects.length;
    index += GITLAB_WEBHOOK_ENSURE_CONCURRENCY
  ) {
    const chunk = projects.slice(
      index,
      index + GITLAB_WEBHOOK_ENSURE_CONCURRENCY,
    );

    results.push(
      ...(await Promise.all(
        chunk.map(async (project): Promise<GitLabWebhookRemoveResult> => {
          try {
            const existingHook = await findGitLabProjectWebhookByUrl({
              projectId: project.projectId,
              webhookUrl,
              token: gitLabToken,
              apiBaseUrl,
              fetchImpl,
            });

            if (!existingHook) {
              return {
                repositoryFullName: project.repositoryFullName,
                status: 'not_found',
              };
            }

            await requestGitLab(
              {
                apiBaseUrl,
                fetchImpl,
                method: 'DELETE',
                path: `/projects/${encodeURIComponent(project.projectId)}/hooks/${existingHook.id}`,
                token: gitLabToken,
              },
              [204, 404],
            );

            return {
              repositoryFullName: project.repositoryFullName,
              status: 'removed',
            };
          } catch (error) {
            return {
              repositoryFullName: project.repositoryFullName,
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      )),
    );
  }

  return results;
}

export function buildGitLabRepositoryValues({
  project,
  linkedByUserId,
  baseUrl = DEFAULT_GITLAB_BASE_URL,
}: {
  project: GitLabProject;
  linkedByUserId: string;
  baseUrl?: string;
}): GitLabRepositoryValues {
  const fullName = project.path_with_namespace;
  const host = hostFromBaseUrl(baseUrl);

  return {
    sourceControlProvider: GITLAB_PROVIDER,
    installationId: null,
    userId: null,
    githubRepoId: null,
    externalRepoId: String(project.id),
    host,
    name: project.name,
    fullName,
    description: project.description ?? null,
    private: project.visibility !== 'public',
    defaultBranch: project.default_branch ?? 'main',
    cloneUrl:
      project.http_url_to_repo ??
      buildRepositoryCloneUrl({
        provider: GITLAB_PROVIDER,
        host,
        repositoryFullName: fullName,
      }),
    htmlUrl: project.web_url ?? buildGitLabWebUrl(baseUrl, fullName),
    permissions:
      project.permissions && typeof project.permissions === 'object'
        ? (project.permissions as Record<string, unknown>)
        : {},
    isActive: true,
    linkedByUserId,
  };
}

export async function syncGitLabRepositories({
  userId,
  token,
  baseUrl,
  projects,
  fetchImpl,
}: {
  userId: string;
  token?: string;
  baseUrl?: string;
  projects?: GitLabProject[];
  fetchImpl?: typeof fetch;
}) {
  const resolvedBaseUrl = baseUrl ?? (await resolveGitLabBaseUrl());
  const existingIds = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.sourceControlProvider, GITLAB_PROVIDER),
          eq(repositories.isActive, true),
        ),
      )
  ).map((repository) => repository.id);

  const gitLabProjects =
    projects ??
    (await listGitLabProjects({
      token,
      baseUrl: resolvedBaseUrl,
      fetchImpl,
    }));

  const syncedRepositories = [];

  for (const project of gitLabProjects) {
    const values = buildGitLabRepositoryValues({
      project,
      linkedByUserId: userId,
      baseUrl: resolvedBaseUrl,
    });

    const findExistingRepository = () =>
      db.query.repositories.findFirst({
        where: and(
          eq(repositories.sourceControlProvider, GITLAB_PROVIDER),
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

function getScopedTokenExpiryDate(): string {
  const expiresAt = new Date();
  expiresAt.setUTCDate(
    expiresAt.getUTCDate() + GITLAB_SCOPED_PROJECT_TOKEN_TTL_DAYS,
  );
  return expiresAt.toISOString().slice(0, 10);
}

function buildScopedTokenName(runId: number, repositoryFullName: string) {
  const repositorySlug = repositoryFullName.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `roomote-job-${runId}-${repositorySlug}-${Date.now()}`.slice(0, 255);
}

function normalizeRepositorySelection(repositoryNames: string[]): string[] {
  return [...new Set(repositoryNames.filter(Boolean))];
}

async function resolveGitLabRepositoryNamesForTaskRun(
  taskRun: TaskRun,
): Promise<string[]> {
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

  throw new Error(
    `GitLab source control jobs require an explicit repository scope for task run ${taskRun.id}.`,
  );
}

async function resolveGitLabRepositoryRowsForTaskRun(taskRun: TaskRun) {
  const repositoryNames = await resolveGitLabRepositoryNamesForTaskRun(taskRun);

  const repositoryRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, GITLAB_PROVIDER),
      eq(repositories.isActive, true),
      inArray(repositories.fullName, repositoryNames),
    ),
    columns: {
      fullName: true,
      externalRepoId: true,
    },
  });

  const repositoryByName = new Map(
    repositoryRows.map((repository) => [repository.fullName, repository]),
  );
  const missingRepositories = repositoryNames.filter(
    (repositoryName) => !repositoryByName.has(repositoryName),
  );

  if (missingRepositories.length > 0) {
    throw new Error(
      `Selected GitLab repositories not found for task run ${taskRun.id}: ${missingRepositories.join(', ')}`,
    );
  }

  return repositoryNames.map((repositoryName) => {
    const repository = repositoryByName.get(repositoryName);

    if (!repository?.externalRepoId?.trim()) {
      throw new Error(
        `GitLab repository ${repositoryName} is missing an external project id.`,
      );
    }

    return {
      repositoryFullName: repository.fullName,
      projectId: repository.externalRepoId,
    };
  });
}

function readScopedProjectTokenDescriptors(
  artifacts: unknown,
): GitLabScopedProjectTokenDescriptor[] {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return [];
  }

  const parsed = gitLabScopedProjectTokenDescriptorListSchema.safeParse(
    (artifacts as Record<string, unknown>)[
      GITLAB_SCOPED_PROJECT_TOKENS_ARTIFACT_KEY
    ],
  );

  return parsed.success ? parsed.data : [];
}

async function createScopedProjectToken(params: {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  host: string;
  projectId: string;
  repositoryFullName: string;
  runId: number;
  token: string;
}): Promise<{
  credential: GitLabScopedProjectTokenCredential;
  descriptor: GitLabScopedProjectTokenDescriptor;
}> {
  const { data } = await requestGitLabJson({
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
    method: 'POST',
    path: `/projects/${encodeURIComponent(params.projectId)}/access_tokens`,
    params: {},
    token: params.token,
    body: {
      name: buildScopedTokenName(params.runId, params.repositoryFullName),
      access_level: GITLAB_SCOPED_PROJECT_TOKEN_ACCESS_LEVEL_DEVELOPER,
      scopes: [...GITLAB_SCOPED_PROJECT_TOKEN_SCOPES],
      expires_at: getScopedTokenExpiryDate(),
    },
    schema: gitLabProjectAccessTokenSchema,
  });

  return {
    credential: {
      host: params.host,
      repositoryFullName: params.repositoryFullName,
      username: data.username?.trim() || 'oauth2',
      token: data.token,
    },
    descriptor: {
      repositoryFullName: params.repositoryFullName,
      projectId: params.projectId,
      tokenId: data.id,
    },
  };
}

async function rotateScopedProjectToken(params: {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  host: string;
  descriptor: GitLabScopedProjectTokenDescriptor;
  token: string;
}): Promise<{
  credential: GitLabScopedProjectTokenCredential;
  descriptor: GitLabScopedProjectTokenDescriptor;
}> {
  const { data } = await requestGitLabJson({
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
    method: 'POST',
    path: `/projects/${encodeURIComponent(params.descriptor.projectId)}/access_tokens/${params.descriptor.tokenId}/rotate`,
    params: {},
    token: params.token,
    body: {
      expires_at: getScopedTokenExpiryDate(),
    },
    schema: gitLabProjectAccessTokenSchema,
  });

  return {
    credential: {
      host: params.host,
      repositoryFullName: params.descriptor.repositoryFullName,
      username: data.username?.trim() || 'oauth2',
      token: data.token,
    },
    descriptor: {
      repositoryFullName: params.descriptor.repositoryFullName,
      projectId: params.descriptor.projectId,
      tokenId: data.id,
    },
  };
}

export async function revokeGitLabScopedProjectToken(params: {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  projectId: string;
  tokenId: number;
  token: string;
}): Promise<void> {
  await requestGitLab(
    {
      apiBaseUrl: params.apiBaseUrl,
      fetchImpl: params.fetchImpl,
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(params.projectId)}/access_tokens/${params.tokenId}`,
      token: params.token,
    },
    [204, 404],
  );
}

async function revokeScopedProjectTokenDescriptors(
  descriptors: GitLabScopedProjectTokenDescriptor[],
  options: {
    apiBaseUrl?: string;
    fetchImpl?: typeof fetch;
    token: string;
  },
): Promise<void> {
  if (descriptors.length === 0) {
    return;
  }

  const results = await Promise.allSettled(
    descriptors.map((descriptor) =>
      revokeGitLabScopedProjectToken({
        apiBaseUrl: options.apiBaseUrl,
        fetchImpl: options.fetchImpl,
        projectId: descriptor.projectId,
        tokenId: descriptor.tokenId,
        token: options.token,
      }),
    ),
  );
  const failedRepositories = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [descriptors[index]!.repositoryFullName]
      : [],
  );

  if (failedRepositories.length > 0) {
    throw new Error(
      `Failed to revoke GitLab scoped tokens for repositories: ${failedRepositories.join(', ')}`,
    );
  }
}

export async function createTaskRunScopedGitLabTokens(
  taskRun: TaskRun,
  options?: {
    apiBaseUrl?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<{
  credentials: GitLabScopedProjectTokenCredential[];
  proxyCredentials: GitLabScopedProjectTokenCredential[];
  artifactsPatch: Record<string, GitLabScopedProjectTokenDescriptor[]>;
}> {
  const deploymentToken = await resolveGitLabToken();

  if (!deploymentToken?.trim()) {
    throw new Error('GITLAB_TOKEN is required for GitLab source control jobs.');
  }

  const baseUrl = options?.baseUrl ?? (await resolveGitLabBaseUrl());
  const apiBaseUrl = options?.apiBaseUrl ?? buildGitLabApiBaseUrl(baseUrl);
  const host = hostFromBaseUrl(baseUrl);
  const repositoriesList = await resolveGitLabRepositoryRowsForTaskRun(taskRun);
  const persistedDescriptors = new Map(
    readScopedProjectTokenDescriptors(taskRun.artifacts).map((descriptor) => [
      descriptor.repositoryFullName,
      descriptor,
    ]),
  );
  const selectedRepositoryNames = new Set(
    repositoriesList.map((repository) => repository.repositoryFullName),
  );
  const staleDescriptors = [...persistedDescriptors.values()].filter(
    (descriptor) => !selectedRepositoryNames.has(descriptor.repositoryFullName),
  );
  const nextDescriptors: GitLabScopedProjectTokenDescriptor[] = [];
  const credentials: GitLabScopedProjectTokenCredential[] = [];

  try {
    await revokeScopedProjectTokenDescriptors(staleDescriptors, {
      apiBaseUrl,
      fetchImpl: options?.fetchImpl,
      token: deploymentToken,
    });

    for (const repository of repositoriesList) {
      const existingDescriptor = persistedDescriptors.get(
        repository.repositoryFullName,
      );

      const scopedToken = existingDescriptor
        ? await rotateScopedProjectToken({
            apiBaseUrl,
            fetchImpl: options?.fetchImpl,
            host,
            descriptor: existingDescriptor,
            token: deploymentToken,
          }).catch(
            async () =>
              await createScopedProjectToken({
                apiBaseUrl,
                fetchImpl: options?.fetchImpl,
                host,
                projectId: repository.projectId,
                repositoryFullName: repository.repositoryFullName,
                runId: taskRun.id,
                token: deploymentToken,
              }),
          )
        : await createScopedProjectToken({
            apiBaseUrl,
            fetchImpl: options?.fetchImpl,
            host,
            projectId: repository.projectId,
            repositoryFullName: repository.repositoryFullName,
            runId: taskRun.id,
            token: deploymentToken,
          });

      credentials.push(scopedToken.credential);
      nextDescriptors.push(scopedToken.descriptor);
    }
  } catch (error) {
    await revokeScopedProjectTokenDescriptors(nextDescriptors, {
      apiBaseUrl,
      fetchImpl: options?.fetchImpl,
      token: deploymentToken,
    }).catch(() => undefined);

    if (isGitLabPermissionError(error)) {
      // The deployment token cannot mint scoped project tokens (for example
      // gitlab.com Free-tier namespaces, where project access tokens require
      // a paid plan). Fall back to the deployment token itself, routed
      // through the worker-local git proxy so the raw token never lands in a
      // task-readable credential file. All-or-nothing per job: mixing scoped
      // credential-helper entries with proxy insteadOf rewrites on the same
      // host would send scoped-credential clones through the proxy too.
      return {
        credentials: [],
        proxyCredentials: repositoriesList.map((repository) => ({
          host,
          repositoryFullName: repository.repositoryFullName,
          username: 'oauth2',
          token: deploymentToken,
        })),
        artifactsPatch: {
          [GITLAB_SCOPED_PROJECT_TOKENS_ARTIFACT_KEY]: [],
        },
      };
    }

    throw error;
  }

  return {
    credentials,
    proxyCredentials: [],
    artifactsPatch: {
      [GITLAB_SCOPED_PROJECT_TOKENS_ARTIFACT_KEY]: nextDescriptors,
    },
  };
}

export async function revokeTaskRunScopedGitLabTokens(
  taskRun: Pick<TaskRun, 'artifacts'>,
  options?: {
    apiBaseUrl?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    token?: string | null;
  },
): Promise<void> {
  const descriptors = readScopedProjectTokenDescriptors(taskRun.artifacts);

  if (descriptors.length === 0) {
    return;
  }

  const deploymentToken = options?.token ?? (await resolveGitLabToken());

  if (!deploymentToken?.trim()) {
    return;
  }

  const apiBaseUrl =
    options?.apiBaseUrl ??
    buildGitLabApiBaseUrl(options?.baseUrl ?? (await resolveGitLabBaseUrl()));

  await Promise.allSettled(
    descriptors.map((descriptor) =>
      revokeGitLabScopedProjectToken({
        apiBaseUrl,
        fetchImpl: options?.fetchImpl,
        projectId: descriptor.projectId,
        tokenId: descriptor.tokenId,
        token: deploymentToken,
      }),
    ),
  );
}

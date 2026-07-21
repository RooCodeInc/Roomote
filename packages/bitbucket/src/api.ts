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
import {
  getBitbucketOAuthConnection,
  resolveBitbucketOAuthAccessToken,
} from './oauth';

const BITBUCKET_PROVIDER = 'bitbucket' satisfies SourceControlProvider;
const DEFAULT_BITBUCKET_BASE_URL = 'https://bitbucket.org';
const BITBUCKET_REPOSITORIES_PER_PAGE = 50;
const BITBUCKET_WEBHOOK_ENSURE_CONCURRENCY = 5;
const BITBUCKET_FAILURE_EVIDENCE_MAX_STEPS = 5;
const BITBUCKET_FAILURE_EVIDENCE_TRACE_CHARS = 6_000;
const BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS = 5_000;

const BITBUCKET_WEBHOOK_EVENTS = [
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
  'pullrequest:comment_created',
  'pullrequest:comment_updated',
  // CI Failure Triage: Bitbucket Pipelines posts commit statuses; failures are
  // filtered in the webhook handler.
  'repo:commit_status_created',
  'repo:commit_status_updated',
] as const;

const bitbucketUuidSchema = z.string().min(1);

const bitbucketRepositorySchema = z.object({
  uuid: bitbucketUuidSchema,
  name: z.string(),
  full_name: z.string(),
  slug: z.string().optional(),
  description: z.string().nullable().optional(),
  is_private: z.boolean().optional(),
  mainbranch: z
    .object({
      name: z.string().optional(),
    })
    .nullable()
    .optional(),
  links: z
    .object({
      html: z
        .object({
          href: z.string().optional(),
        })
        .optional(),
      clone: z
        .array(
          z.object({
            name: z.string().optional(),
            href: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  workspace: z
    .object({
      slug: z.string().optional(),
      uuid: z.string().optional(),
    })
    .optional(),
});

const bitbucketPaginatedRepositoriesSchema = z.object({
  values: z.array(bitbucketRepositorySchema),
  next: z.string().nullable().optional(),
});

const bitbucketWorkspaceMembershipSchema = z.object({
  workspace: z.object({
    slug: z.string().optional(),
    uuid: z.string().optional(),
  }),
});

const bitbucketPaginatedWorkspaceMembershipsSchema = z.object({
  values: z.array(bitbucketWorkspaceMembershipSchema),
  next: z.string().nullable().optional(),
});

const bitbucketUserSchema = z.object({
  uuid: z.string().optional(),
  account_id: z.string().optional(),
  username: z.string().optional(),
  nickname: z.string().optional(),
  display_name: z.string().optional(),
});

const bitbucketCommentSchema = z.object({
  id: z.number(),
});

const bitbucketHookSchema = z
  .object({
    uuid: z.string().optional(),
    url: z.string().optional(),
    description: z.string().optional(),
    events: z.array(z.string()).optional(),
    active: z.boolean().optional(),
  })
  .passthrough();

const bitbucketPaginatedHooksSchema = z.object({
  values: z.array(bitbucketHookSchema),
  next: z.string().nullable().optional(),
});

export type BitbucketRepository = z.infer<typeof bitbucketRepositorySchema>;
export type BitbucketCurrentUser = {
  login: string;
  accountId: string | null;
  uuid: string | null;
};
export type BitbucketRepositoryCredential = {
  host: string;
  repositoryFullName: string;
  username: string;
  token: string;
  originBaseUrl: string;
  authScheme: 'basic';
};

export type BitbucketRepositoryValues = {
  sourceControlProvider: typeof BITBUCKET_PROVIDER;
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

export type ListBitbucketRepositoriesOptions = {
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  stopAfter?: number;
};

export type BitbucketWebhookEnsureResult = {
  repositoryFullName: string;
  status: 'created' | 'updated' | 'failed';
  error?: string;
};

export type BitbucketWebhookRemoveResult = {
  repositoryFullName: string;
  status: 'removed' | 'not_found' | 'failed';
  error?: string;
};

export class BitbucketApiError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`Bitbucket API request failed: ${status} ${statusText}`);
    this.name = 'BitbucketApiError';
    this.status = status;
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlashes(baseUrl.trim());

  if (!trimmed) {
    throw new Error('BITBUCKET_BASE_URL cannot be empty.');
  }

  return new URL(trimmed).toString().replace(/\/+$/, '');
}

function hostFromBaseUrl(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl)).host;
}

export function buildBitbucketApiBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const host = new URL(normalized).hostname.toLowerCase();

  if (host === 'bitbucket.org' || host === 'www.bitbucket.org') {
    return 'https://api.bitbucket.org/2.0';
  }

  throw new Error(
    'Only Bitbucket Cloud (bitbucket.org) is supported. Self-hosted Bitbucket Server/Data Center is not configured yet.',
  );
}

function buildAuthorizationHeader(username: string, token: string): string {
  return `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
}

export function stripUuidBraces(value: string): string {
  return value.replace(/^\{|\}$/g, '');
}

/** Encode a Bitbucket UUID path segment, preserving braces when present. */
export function encodeBitbucketUuid(uuid: string): string {
  const trimmed = uuid.trim();
  if (!trimmed) {
    return trimmed;
  }
  const bare = stripUuidBraces(trimmed);
  return encodeURIComponent(`{${bare}}`);
}

/**
 * Host of the deployment-configured Bitbucket base URL (bitbucket.org).
 * Manual Run matches repository `host` against this.
 */
export async function resolveBitbucketInstanceHost(): Promise<string> {
  return hostFromBaseUrl(await resolveBitbucketBaseUrl()).toLowerCase();
}

const bitbucketPipelineSchema = z
  .object({
    uuid: z.string(),
    build_number: z.number().optional(),
    created_on: z.string().optional(),
    completed_on: z.string().nullable().optional(),
    target: z
      .object({
        ref_name: z.string().optional(),
        selector: z
          .object({
            type: z.string().optional(),
            pattern: z.string().optional(),
          })
          .passthrough()
          .nullish(),
        commit: z
          .object({
            hash: z.string().optional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    state: z
      .object({
        name: z.string().optional(),
        type: z.string().optional(),
        result: z
          .object({
            name: z.string().optional(),
            type: z.string().optional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    links: z
      .object({
        self: z
          .object({
            href: z.string().optional(),
          })
          .optional(),
        steps: z
          .object({
            href: z.string().optional(),
          })
          .optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const bitbucketPipelineListSchema = z.object({
  values: z.array(bitbucketPipelineSchema),
  next: z.string().nullable().optional(),
});

const bitbucketPipelineStepSchema = z
  .object({
    uuid: z.string().optional(),
    name: z.string().optional(),
    state: z
      .object({
        name: z.string().optional(),
        type: z.string().optional(),
        result: z
          .object({
            name: z.string().optional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const bitbucketPipelineStepListSchema = z.object({
  values: z.array(bitbucketPipelineStepSchema),
  next: z.string().nullable().optional(),
});

export type BitbucketPipeline = z.infer<typeof bitbucketPipelineSchema>;
export type BitbucketPipelineStep = z.infer<typeof bitbucketPipelineStepSchema>;

export function getBitbucketPipelineResultName(
  pipeline: BitbucketPipeline,
): string {
  return (pipeline.state?.result?.name ?? pipeline.state?.name ?? '')
    .trim()
    .toUpperCase();
}

export function getBitbucketPipelineWebUrl(params: {
  repositoryFullName: string;
  pipeline: BitbucketPipeline;
  baseUrl?: string;
}): string {
  const host = hostFromBaseUrl(params.baseUrl ?? DEFAULT_BITBUCKET_BASE_URL);
  const buildNumber = params.pipeline.build_number;
  if (buildNumber !== undefined) {
    return `https://${host}/${params.repositoryFullName}/addon/pipelines/home#!/results/${buildNumber}`;
  }
  return `https://${host}/${params.repositoryFullName}/addon/pipelines/home#!/results/${stripUuidBraces(params.pipeline.uuid)}`;
}

/**
 * Newest pipeline for a branch tip. Does not filter by result so callers can
 * detect already-green tips before launching triage.
 */
export async function getLatestBitbucketPipeline(params: {
  repositoryFullName: string;
  branch: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketPipeline | null> {
  const auth = await resolveAuthIdentity({
    token: params.token,
    username: params.username,
    baseUrl: params.baseUrl,
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { workspace, repo } = splitBitbucketRepositoryFullName(
    params.repositoryFullName,
  );

  const response = await (params.fetchImpl ?? fetch)(
    buildBitbucketApiUrl(
      auth.apiBaseUrl,
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/`,
      {
        pagelen: 1,
        sort: '-created_on',
        'target.ref_name': params.branch,
      },
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          auth.authScheme === 'bearer'
            ? `Bearer ${auth.token}`
            : buildAuthorizationHeader(auth.username, auth.token),
      },
      signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  // Bitbucket answers a missing `pipeline` OAuth scope with 401/403. Throw so
  // callers surface a credential/scope problem instead of reading it as "no
  // failed pipeline"; only an unknown repository/pipeline maps to null.
  if ([401, 403].includes(response.status)) {
    throw new Error(
      `Bitbucket rejected the Pipelines API request (status ${response.status}). Confirm the OAuth consumer has the pipeline scope and the connection has been re-authorized.`,
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new BitbucketApiError(response.status, response.statusText);
  }

  const { values } = bitbucketPipelineListSchema.parse(await response.json());
  return values[0] ?? null;
}

export async function getBitbucketPipeline(params: {
  repositoryFullName: string;
  pipelineUuid: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketPipeline | null> {
  const auth = await resolveAuthIdentity({
    token: params.token,
    username: params.username,
    baseUrl: params.baseUrl,
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { workspace, repo } = splitBitbucketRepositoryFullName(
    params.repositoryFullName,
  );

  const response = await (params.fetchImpl ?? fetch)(
    buildBitbucketApiUrl(
      auth.apiBaseUrl,
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/${encodeBitbucketUuid(params.pipelineUuid)}`,
      {},
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          auth.authScheme === 'bearer'
            ? `Bearer ${auth.token}`
            : buildAuthorizationHeader(auth.username, auth.token),
      },
      signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  // Bitbucket answers a missing `pipeline` OAuth scope with 401/403. Throw so
  // callers surface a credential/scope problem instead of reading it as "no
  // failed pipeline"; only an unknown repository/pipeline maps to null.
  if ([401, 403].includes(response.status)) {
    throw new Error(
      `Bitbucket rejected the Pipelines API request (status ${response.status}). Confirm the OAuth consumer has the pipeline scope and the connection has been re-authorized.`,
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new BitbucketApiError(response.status, response.statusText);
  }

  return bitbucketPipelineSchema.parse(await response.json());
}

/**
 * Resolve a pipeline by build number on a branch (status webhook URLs often
 * only include the numeric results id). Scans only the newest 20 pipelines on
 * the branch, so a long-delayed webhook on a busy repository can miss; the
 * webhook handler retries on the default branch and then skips.
 */
export async function getBitbucketPipelineByBuildNumber(params: {
  repositoryFullName: string;
  branch: string;
  buildNumber: number;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketPipeline | null> {
  const auth = await resolveAuthIdentity({
    token: params.token,
    username: params.username,
    baseUrl: params.baseUrl,
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { workspace, repo } = splitBitbucketRepositoryFullName(
    params.repositoryFullName,
  );

  const response = await (params.fetchImpl ?? fetch)(
    buildBitbucketApiUrl(
      auth.apiBaseUrl,
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/`,
      {
        pagelen: 20,
        sort: '-created_on',
        'target.ref_name': params.branch,
      },
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          auth.authScheme === 'bearer'
            ? `Bearer ${auth.token}`
            : buildAuthorizationHeader(auth.username, auth.token),
      },
      signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  // Bitbucket answers a missing `pipeline` OAuth scope with 401/403. Throw so
  // callers surface a credential/scope problem instead of reading it as "no
  // failed pipeline"; only an unknown repository/pipeline maps to null.
  if ([401, 403].includes(response.status)) {
    throw new Error(
      `Bitbucket rejected the Pipelines API request (status ${response.status}). Confirm the OAuth consumer has the pipeline scope and the connection has been re-authorized.`,
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new BitbucketApiError(response.status, response.statusText);
  }

  const { values } = bitbucketPipelineListSchema.parse(await response.json());
  return (
    values.find((pipeline) => pipeline.build_number === params.buildNumber) ??
    null
  );
}

async function readResponseTextTail(
  response: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return {
      text: text.slice(-maxChars),
      truncated: text.length > maxChars,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let totalChars = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    totalChars += chunk.length;
    tail = `${tail}${chunk}`.slice(-maxChars);
  }

  const finalChunk = decoder.decode();
  totalChars += finalChunk.length;
  tail = `${tail}${finalChunk}`.slice(-maxChars);

  return { text: tail, truncated: totalChars > maxChars };
}

function formatBitbucketPipelineStepEvidence(params: {
  step: BitbucketPipelineStep;
  logText: string | null;
  logTruncated: boolean;
}): string {
  const resultName =
    params.step.state?.result?.name ?? params.step.state?.name ?? 'unknown';
  const metadata = [
    `step=${JSON.stringify(params.step.name ?? 'unknown')}`,
    ...(params.step.uuid
      ? [`id=${JSON.stringify(stripUuidBraces(params.step.uuid))}`]
      : []),
    `result=${JSON.stringify(resultName)}`,
  ].join(' ');

  if (!params.logText) {
    return `${metadata}\nLog trace unavailable.`;
  }

  return `${metadata}\n${
    params.logTruncated
      ? '[Earlier log output omitted; showing the tail.]\n'
      : ''
  }${params.logText}`;
}

/**
 * Bounded, prompt-ready snapshot of failed pipeline steps and log tails.
 */
export async function getBitbucketPipelineFailureEvidence(params: {
  repositoryFullName: string;
  pipelineUuid: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const auth = await resolveAuthIdentity({
    token: params.token,
    username: params.username,
    baseUrl: params.baseUrl,
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { workspace, repo } = splitBitbucketRepositoryFullName(
    params.repositoryFullName,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  const pipelinePath = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/${encodeBitbucketUuid(params.pipelineUuid)}`;

  const stepsResponse = await fetchImpl(
    buildBitbucketApiUrl(auth.apiBaseUrl, `${pipelinePath}/steps/`, {
      pagelen: 50,
    }),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          auth.authScheme === 'bearer'
            ? `Bearer ${auth.token}`
            : buildAuthorizationHeader(auth.username, auth.token),
      },
      signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  if ([401, 403, 404].includes(stepsResponse.status)) {
    return null;
  }

  if (stepsResponse.status !== 200) {
    throw new BitbucketApiError(stepsResponse.status, stepsResponse.statusText);
  }

  const { values: steps } = bitbucketPipelineStepListSchema.parse(
    await stepsResponse.json(),
  );
  const failedSteps = steps
    .filter((step) => {
      const result = (step.state?.result?.name ?? step.state?.name ?? '')
        .trim()
        .toUpperCase();
      return result === 'FAILED' || result === 'ERROR';
    })
    .slice(0, BITBUCKET_FAILURE_EVIDENCE_MAX_STEPS);

  if (failedSteps.length === 0) {
    return null;
  }

  const evidence = await Promise.all(
    failedSteps.map(async (step) => {
      const stepUuid = step.uuid?.trim();
      if (!stepUuid) {
        return formatBitbucketPipelineStepEvidence({
          step,
          logText: null,
          logTruncated: false,
        });
      }

      try {
        const logResponse = await fetchImpl(
          buildBitbucketApiUrl(
            auth.apiBaseUrl,
            `${pipelinePath}/steps/${encodeBitbucketUuid(stepUuid)}/log`,
            {},
          ),
          {
            method: 'GET',
            headers: {
              // The step log endpoint serves application/octet-stream and
              // responds 406 to Accept: text/plain.
              Accept: 'application/octet-stream',
              Authorization:
                auth.authScheme === 'bearer'
                  ? `Bearer ${auth.token}`
                  : buildAuthorizationHeader(auth.username, auth.token),
            },
            signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
          },
        );

        if (logResponse.status !== 200) {
          return formatBitbucketPipelineStepEvidence({
            step,
            logText: null,
            logTruncated: false,
          });
        }

        const tail = await readResponseTextTail(
          logResponse,
          BITBUCKET_FAILURE_EVIDENCE_TRACE_CHARS,
        );
        return formatBitbucketPipelineStepEvidence({
          step,
          logText: tail.text.trim() || null,
          logTruncated: tail.truncated,
        });
      } catch {
        return formatBitbucketPipelineStepEvidence({
          step,
          logText: null,
          logTruncated: false,
        });
      }
    }),
  );

  return evidence.join('\n\n');
}

function getBitbucketLogin(user: z.infer<typeof bitbucketUserSchema>): string {
  const login = user.username?.trim() || user.nickname?.trim();

  if (!login) {
    throw new Error('Bitbucket user response did not include a username.');
  }

  return login;
}

function getBitbucketAccountKey(
  user: z.infer<typeof bitbucketUserSchema>,
): string | null {
  if (user.account_id?.trim()) {
    return user.account_id.trim();
  }

  if (user.uuid?.trim()) {
    return stripUuidBraces(user.uuid.trim());
  }

  return null;
}

export function normalizeBitbucketLinkedAccountKey(value: string): string {
  return stripUuidBraces(value.trim()).toLowerCase();
}

export async function resolveBitbucketToken(): Promise<string | null> {
  const connection = await getBitbucketOAuthConnection();
  if (connection?.status === 'reauthorization_required') {
    throw new Error(
      'Bitbucket OAuth authorization requires reconnection. Reconnect the Bitbucket OAuth consumer in source-control settings.',
    );
  }
  return resolveBitbucketOAuthAccessToken();
}

export async function resolveBitbucketBaseUrl(): Promise<string> {
  const baseUrl = await resolveDeploymentEnvVar('BITBUCKET_BASE_URL');
  return baseUrl?.trim()
    ? normalizeBaseUrl(baseUrl)
    : DEFAULT_BITBUCKET_BASE_URL;
}

export async function resolveBitbucketUsername(): Promise<string | null> {
  return (await getBitbucketOAuthConnection())?.status === 'active'
    ? (await getBitbucketOAuthConnection())?.username || 'x-token-auth'
    : null;
}

export type BitbucketAuthDescriptor = {
  token: string;
  username: string;
  baseUrl: string;
  apiBaseUrl: string;
  authScheme: 'basic' | 'bearer';
};

export async function resolveBitbucketAuth(): Promise<BitbucketAuthDescriptor> {
  const connection = await getBitbucketOAuthConnection();
  if (connection?.status === 'reauthorization_required') {
    throw new Error(
      'Bitbucket OAuth authorization requires reconnection. Reconnect the Bitbucket OAuth consumer in source-control settings.',
    );
  }
  const token = await resolveBitbucketOAuthAccessToken();
  if (token && connection) {
    const baseUrl = await resolveBitbucketBaseUrl();
    return {
      token,
      username: connection.username || 'x-token-auth',
      baseUrl,
      apiBaseUrl: buildBitbucketApiBaseUrl(baseUrl),
      authScheme: 'bearer',
    };
  }
  throw new Error(
    'Bitbucket OAuth authorization is required. Connect the Bitbucket OAuth consumer in source-control settings.',
  );
}

let cachedBitbucketDeploymentUser: {
  token: string;
  baseUrl: string;
  user: BitbucketCurrentUser;
} | null = null;

function buildBitbucketApiUrl(
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

async function requestBitbucketJson<T>({
  apiBaseUrl,
  fetchImpl = fetch,
  method = 'GET',
  path,
  params = {},
  username,
  token,
  authScheme,
  body,
  schema,
  absoluteUrl,
}: {
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path?: string;
  params?: Record<string, string | number | boolean>;
  username?: string;
  token: string;
  authScheme?: 'basic' | 'bearer';
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
  absoluteUrl?: string;
}): Promise<{ data: T; response: Response }> {
  const response = await fetchImpl(
    absoluteUrl ?? buildBitbucketApiUrl(apiBaseUrl, path ?? '', params),
    {
      method,
      headers: {
        Accept: 'application/json',
        Authorization:
          (authScheme ?? 'basic') === 'bearer'
            ? `Bearer ${token}`
            : buildAuthorizationHeader(username ?? '', token),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  if (method === 'DELETE' && [200, 204, 404].includes(response.status)) {
    return {
      data: undefined as T,
      response,
    };
  }

  if (![200, 201].includes(response.status)) {
    throw new BitbucketApiError(response.status, response.statusText);
  }

  if (response.status === 204) {
    return {
      data: undefined as T,
      response,
    };
  }

  return {
    data: schema.parse(await response.json()),
    response,
  };
}

async function resolveAuthIdentity({
  token,
  username,
  baseUrl,
  apiBaseUrl,
  fetchImpl: _fetchImpl,
}: {
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketAuthDescriptor> {
  if (!token && !username && !baseUrl && !apiBaseUrl)
    return resolveBitbucketAuth();
  const resolvedToken = token ?? (await resolveBitbucketToken());

  if (!resolvedToken?.trim())
    throw new Error(
      'Bitbucket OAuth authorization is required for Bitbucket source control.',
    );

  const resolvedBaseUrl = baseUrl ?? (await resolveBitbucketBaseUrl());
  const resolvedApiBaseUrl =
    apiBaseUrl ?? buildBitbucketApiBaseUrl(resolvedBaseUrl);
  const configuredUsername =
    username ?? (await resolveBitbucketUsername()) ?? undefined;

  const oauthConnection = await getBitbucketOAuthConnection();
  const authScheme =
    oauthConnection?.accessToken === resolvedToken ? 'bearer' : 'basic';

  if (authScheme === 'bearer' || configuredUsername?.trim()) {
    return {
      token: resolvedToken,
      username:
        configuredUsername?.trim() ??
        oauthConnection?.username ??
        'x-token-auth',
      baseUrl: resolvedBaseUrl,
      apiBaseUrl: resolvedApiBaseUrl,
      authScheme,
    };
  }

  throw new Error(
    'Bitbucket OAuth authorization is required for source-control API requests.',
  );
}

export async function getBitbucketAuthenticatedUser({
  token,
  username,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
}: {
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<BitbucketCurrentUser> {
  const auth = await resolveAuthIdentity({
    token,
    username,
    baseUrl,
    apiBaseUrl,
    fetchImpl,
  });

  const { data } = await requestBitbucketJson({
    apiBaseUrl: auth.apiBaseUrl,
    fetchImpl,
    path: '/user',
    username: auth.username,
    token: auth.token,
    authScheme: auth.authScheme,
    schema: bitbucketUserSchema,
  });

  return {
    login: getBitbucketLogin(data) || auth.username,
    accountId: getBitbucketAccountKey(data),
    uuid: data.uuid ? stripUuidBraces(data.uuid) : null,
  };
}

export async function listBitbucketRepositories({
  token,
  username,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
  stopAfter,
}: ListBitbucketRepositoriesOptions = {}): Promise<BitbucketRepository[]> {
  const auth = await resolveAuthIdentity({
    token,
    username,
    baseUrl,
    apiBaseUrl,
    fetchImpl,
  });

  // Bitbucket removed all cross-workspace listings on April 14, 2026
  // (changelog CHANGE-2770): GET /2.0/repositories?role=..., /2.0/workspaces,
  // and /2.0/user/permissions/workspaces all return 410 Gone. The only
  // supported membership enumeration is the newer GET /2.0/user/workspaces;
  // repositories must then be listed per workspace.
  const workspaceSlugs: string[] = [];
  let workspacesUrl: string | null = buildBitbucketApiUrl(
    auth.apiBaseUrl,
    '/user/workspaces',
    { pagelen: BITBUCKET_REPOSITORIES_PER_PAGE },
  );

  while (workspacesUrl) {
    const {
      data,
    }: {
      data: z.infer<typeof bitbucketPaginatedWorkspaceMembershipsSchema>;
    } = await requestBitbucketJson({
      apiBaseUrl: auth.apiBaseUrl,
      fetchImpl,
      username: auth.username,
      token: auth.token,
      authScheme: auth.authScheme,
      schema: bitbucketPaginatedWorkspaceMembershipsSchema,
      absoluteUrl: workspacesUrl,
    });

    for (const membership of data.values) {
      const slug = membership.workspace.slug?.trim();

      if (slug) {
        workspaceSlugs.push(slug);
      }
    }

    workspacesUrl = data.next ?? null;
  }

  const repositoriesList: BitbucketRepository[] = [];

  for (const workspaceSlug of workspaceSlugs) {
    let nextUrl: string | null = buildBitbucketApiUrl(
      auth.apiBaseUrl,
      `/repositories/${encodeURIComponent(workspaceSlug)}`,
      { pagelen: BITBUCKET_REPOSITORIES_PER_PAGE },
    );

    while (nextUrl) {
      const {
        data,
      }: { data: z.infer<typeof bitbucketPaginatedRepositoriesSchema> } =
        await requestBitbucketJson({
          apiBaseUrl: auth.apiBaseUrl,
          fetchImpl,
          username: auth.username,
          token: auth.token,
          authScheme: auth.authScheme,
          schema: bitbucketPaginatedRepositoriesSchema,
          absoluteUrl: nextUrl,
        });

      repositoriesList.push(...data.values);

      if (stopAfter !== undefined && repositoriesList.length >= stopAfter) {
        return repositoriesList.slice(0, stopAfter);
      }

      nextUrl = data.next ?? null;
    }
  }

  return repositoriesList;
}

function getCloneUrl(repository: BitbucketRepository, host: string): string {
  const httpsClone = repository.links?.clone?.find(
    (entry) => entry.name === 'https' && entry.href,
  )?.href;

  if (httpsClone) {
    try {
      const url = new URL(httpsClone);
      url.username = '';
      url.password = '';
      return url.toString();
    } catch {
      return httpsClone;
    }
  }

  return buildRepositoryCloneUrl({
    provider: BITBUCKET_PROVIDER,
    host,
    repositoryFullName: repository.full_name,
  });
}

export function buildBitbucketRepositoryValues({
  repository,
  linkedByUserId,
  baseUrl,
}: {
  repository: BitbucketRepository;
  linkedByUserId: string;
  baseUrl: string;
}): BitbucketRepositoryValues {
  const fullName = repository.full_name;
  const host = hostFromBaseUrl(baseUrl);

  return {
    sourceControlProvider: BITBUCKET_PROVIDER,
    installationId: null,
    userId: null,
    githubRepoId: null,
    externalRepoId: stripUuidBraces(repository.uuid),
    host,
    name: repository.name,
    fullName,
    description: repository.description ?? null,
    private: repository.is_private ?? true,
    defaultBranch: repository.mainbranch?.name ?? 'main',
    cloneUrl: getCloneUrl(repository, host),
    htmlUrl: repository.links?.html?.href ?? `https://${host}/${fullName}`,
    permissions: {},
    isActive: true,
    linkedByUserId,
  };
}

export async function syncBitbucketRepositories({
  userId,
  token,
  username,
  baseUrl,
  repositories: bitbucketRepositories,
  fetchImpl,
}: {
  userId: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  repositories?: BitbucketRepository[];
  fetchImpl?: typeof fetch;
}) {
  const resolvedBaseUrl = baseUrl ?? (await resolveBitbucketBaseUrl());

  const existingIds = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.sourceControlProvider, BITBUCKET_PROVIDER),
          eq(repositories.isActive, true),
        ),
      )
  ).map((repository) => repository.id);

  const repositoriesToSync =
    bitbucketRepositories ??
    (await listBitbucketRepositories({
      token,
      username,
      baseUrl: resolvedBaseUrl,
      fetchImpl,
    }));

  const syncedRepositories = [];

  for (const repository of repositoriesToSync) {
    const values = buildBitbucketRepositoryValues({
      repository,
      linkedByUserId: userId,
      baseUrl: resolvedBaseUrl,
    });

    const findExistingRepository = () =>
      db.query.repositories.findFirst({
        where: and(
          eq(repositories.sourceControlProvider, BITBUCKET_PROVIDER),
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

async function resolveBitbucketRepositoryNamesForTaskRun(
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

async function resolveBitbucketRepositoryRowsForTaskRun(taskRun: TaskRun) {
  const repositoryNames =
    await resolveBitbucketRepositoryNamesForTaskRun(taskRun);
  const queryConditions = [
    eq(repositories.sourceControlProvider, BITBUCKET_PROVIDER),
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
        `No synced Bitbucket repositories found for task run ${taskRun.id}.`,
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
      `Selected Bitbucket repositories not found for task run ${taskRun.id}: ${missingRepositories.join(', ')}`,
    );
  }

  return repositoryNames.map((repositoryName) => {
    const repository = repositoryByName.get(repositoryName);

    if (!repository) {
      throw new Error(`Bitbucket repository ${repositoryName} is missing.`);
    }

    return repository;
  });
}

export async function getBitbucketDeploymentUser(options?: {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketCurrentUser | null> {
  const token = await resolveBitbucketToken();

  if (!token?.trim()) {
    return null;
  }

  const baseUrl = await resolveBitbucketBaseUrl();
  const username = await resolveBitbucketUsername();

  if (!username?.trim()) {
    return null;
  }

  const cacheBaseUrl = options?.apiBaseUrl ?? baseUrl;

  if (
    cachedBitbucketDeploymentUser?.token === token &&
    cachedBitbucketDeploymentUser.baseUrl === cacheBaseUrl
  ) {
    return cachedBitbucketDeploymentUser.user;
  }

  try {
    const user = await getBitbucketAuthenticatedUser({
      token,
      username,
      baseUrl,
      apiBaseUrl: options?.apiBaseUrl,
      fetchImpl: options?.fetchImpl,
    });

    cachedBitbucketDeploymentUser = {
      token,
      baseUrl: cacheBaseUrl,
      user,
    };

    return user;
  } catch {
    return null;
  }
}

export function clearBitbucketDeploymentUserCache(): void {
  cachedBitbucketDeploymentUser = null;
}

function splitBitbucketRepositoryFullName(repositoryFullName: string): {
  workspace: string;
  repo: string;
} {
  const [workspace, repo, ...extraParts] = repositoryFullName.split('/');

  if (!workspace || !repo || extraParts.length > 0) {
    throw new Error(
      `Bitbucket repository full name must be in workspace/repo format: ${repositoryFullName}`,
    );
  }

  return { workspace, repo };
}

export async function createBitbucketPullRequestComment({
  repositoryFullName,
  pullRequestNumber,
  body,
  token,
  username,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  body: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: number }> {
  const auth = await resolveAuthIdentity({
    token,
    username,
    baseUrl,
    apiBaseUrl,
    fetchImpl,
  });
  const { workspace, repo } =
    splitBitbucketRepositoryFullName(repositoryFullName);
  const { data } = await requestBitbucketJson({
    apiBaseUrl: auth.apiBaseUrl,
    fetchImpl,
    method: 'POST',
    path: `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repo,
    )}/pullrequests/${pullRequestNumber}/comments`,
    username: auth.username,
    token: auth.token,
    authScheme: auth.authScheme,
    body: {
      content: {
        raw: body,
      },
    },
    schema: bitbucketCommentSchema,
  });

  return data;
}

async function findBitbucketRepositoryWebhookByUrl({
  workspace,
  repo,
  webhookUrl,
  username,
  token,
  authScheme,
  apiBaseUrl,
  fetchImpl,
}: {
  workspace: string;
  repo: string;
  webhookUrl: string;
  username: string;
  token: string;
  apiBaseUrl: string;
  authScheme?: 'basic' | 'bearer';
  fetchImpl?: typeof fetch;
}): Promise<z.infer<typeof bitbucketHookSchema> | undefined> {
  let nextUrl: string | null = buildBitbucketApiUrl(
    apiBaseUrl,
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repo,
    )}/hooks`,
    { pagelen: 100 },
  );

  while (nextUrl) {
    const { data }: { data: z.infer<typeof bitbucketPaginatedHooksSchema> } =
      await requestBitbucketJson({
        apiBaseUrl,
        fetchImpl,
        username,
        token,
        authScheme,
        schema: bitbucketPaginatedHooksSchema,
        absoluteUrl: nextUrl,
      });

    const match = data.values.find(
      (hook: z.infer<typeof bitbucketHookSchema>) => hook.url === webhookUrl,
    );

    if (match) {
      return match;
    }

    nextUrl = data.next ?? null;
  }

  return undefined;
}

async function ensureBitbucketRepositoryWebhook({
  repositoryFullName,
  webhookUrl,
  secretToken,
  username,
  token,
  apiBaseUrl,
  authScheme,
  fetchImpl,
}: {
  repositoryFullName: string;
  webhookUrl: string;
  secretToken: string;
  username: string;
  token: string;
  apiBaseUrl: string;
  authScheme?: 'basic' | 'bearer';
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const { workspace, repo } =
    splitBitbucketRepositoryFullName(repositoryFullName);
  const existingHook = await findBitbucketRepositoryWebhookByUrl({
    workspace,
    repo,
    webhookUrl,
    username,
    token,
    authScheme,
    apiBaseUrl,
    fetchImpl,
  });
  const body = {
    description: 'Roomote',
    url: webhookUrl,
    active: true,
    events: [...BITBUCKET_WEBHOOK_EVENTS],
    secret: secretToken,
  };

  if (!existingHook?.uuid) {
    await requestBitbucketJson({
      apiBaseUrl,
      fetchImpl,
      method: 'POST',
      path: `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
        repo,
      )}/hooks`,
      username,
      token,
      authScheme,
      body,
      schema: bitbucketHookSchema,
    });

    return 'created';
  }

  await requestBitbucketJson({
    apiBaseUrl,
    fetchImpl,
    method: 'PUT',
    path: `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repo,
    )}/hooks/${encodeURIComponent(existingHook.uuid)}`,
    username,
    token,
    authScheme,
    body,
    schema: bitbucketHookSchema,
  });

  return 'updated';
}

export async function ensureBitbucketWebhooksForRepositories({
  repositories,
  webhookUrl,
  secretToken,
  token,
  username,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
}: {
  repositories: { repositoryFullName: string }[];
  webhookUrl: string;
  secretToken: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketWebhookEnsureResult[]> {
  const auth = await resolveAuthIdentity({
    token,
    username,
    baseUrl,
    apiBaseUrl,
    fetchImpl,
  });
  const results: BitbucketWebhookEnsureResult[] = [];

  for (
    let index = 0;
    index < repositories.length;
    index += BITBUCKET_WEBHOOK_ENSURE_CONCURRENCY
  ) {
    const chunk = repositories.slice(
      index,
      index + BITBUCKET_WEBHOOK_ENSURE_CONCURRENCY,
    );

    results.push(
      ...(await Promise.all(
        chunk.map(
          async (repository): Promise<BitbucketWebhookEnsureResult> =>
            ensureBitbucketRepositoryWebhook({
              repositoryFullName: repository.repositoryFullName,
              webhookUrl,
              secretToken,
              username: auth.username,
              token: auth.token,
              authScheme: auth.authScheme,
              apiBaseUrl: auth.apiBaseUrl,
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

async function removeBitbucketRepositoryWebhook({
  repositoryFullName,
  webhookUrl,
  username,
  token,
  apiBaseUrl,
  authScheme,
  fetchImpl = fetch,
}: {
  repositoryFullName: string;
  webhookUrl: string;
  username: string;
  token: string;
  apiBaseUrl: string;
  authScheme?: 'basic' | 'bearer';
  fetchImpl?: typeof fetch;
}): Promise<'removed' | 'not_found'> {
  const { workspace, repo } =
    splitBitbucketRepositoryFullName(repositoryFullName);
  const existingHook = await findBitbucketRepositoryWebhookByUrl({
    workspace,
    repo,
    webhookUrl,
    username,
    token,
    authScheme,
    apiBaseUrl,
    fetchImpl,
  });

  if (!existingHook?.uuid) {
    return 'not_found';
  }

  await requestBitbucketJson({
    apiBaseUrl,
    fetchImpl,
    method: 'DELETE',
    path: `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repo,
    )}/hooks/${encodeURIComponent(existingHook.uuid)}`,
    username,
    token,
    authScheme,
    schema: z.undefined(),
  });

  return 'removed';
}

export async function removeBitbucketWebhooksForRepositories({
  repositories,
  webhookUrl,
  token,
  username,
  baseUrl,
  apiBaseUrl,
  fetchImpl,
}: {
  repositories: { repositoryFullName: string }[];
  webhookUrl: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketWebhookRemoveResult[]> {
  const auth = await resolveAuthIdentity({
    token,
    username,
    baseUrl,
    apiBaseUrl,
    fetchImpl,
  });
  const results: BitbucketWebhookRemoveResult[] = [];

  for (
    let index = 0;
    index < repositories.length;
    index += BITBUCKET_WEBHOOK_ENSURE_CONCURRENCY
  ) {
    const chunk = repositories.slice(
      index,
      index + BITBUCKET_WEBHOOK_ENSURE_CONCURRENCY,
    );

    results.push(
      ...(await Promise.all(
        chunk.map(
          async (repository): Promise<BitbucketWebhookRemoveResult> =>
            removeBitbucketRepositoryWebhook({
              repositoryFullName: repository.repositoryFullName,
              webhookUrl,
              username: auth.username,
              token: auth.token,
              authScheme: auth.authScheme,
              apiBaseUrl: auth.apiBaseUrl,
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

export async function createTaskRunBitbucketCredentials(
  taskRun: TaskRun,
  options?: {
    fetchImpl?: typeof fetch;
    token?: string;
    baseUrl?: string;
    username?: string;
  },
): Promise<{
  credentials: BitbucketRepositoryCredential[];
}> {
  const auth = await resolveAuthIdentity({
    token: options?.token,
    username: options?.username,
    baseUrl: options?.baseUrl,
    fetchImpl: options?.fetchImpl,
  });
  const host = hostFromBaseUrl(auth.baseUrl);
  const repositoriesList =
    await resolveBitbucketRepositoryRowsForTaskRun(taskRun);

  return {
    credentials: repositoriesList.map((repository) => ({
      host,
      repositoryFullName: repository.fullName,
      username: 'x-token-auth',
      token: auth.token,
      originBaseUrl: auth.baseUrl,
      authScheme: 'basic',
    })),
  };
}

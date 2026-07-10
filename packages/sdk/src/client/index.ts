import { createTRPCProxyClient, httpBatchLink, httpLink } from '@trpc/client';
import { DEFAULT_AUTH_BYPASS_HEADER_NAME } from '@roomote/types';
import superjson from 'superjson';

import { retryAsync } from './retry';
import * as auth from '../auth';
import * as githubInstallations from '../github-installations';
import * as slackInstallations from '../slack-installations';
import * as linearInstallations from '../linear-installations';
import * as linearSessions from '../linear-sessions';
import * as repositories from '../repositories';
import * as taskRuns from '../task-runs';
import * as environments from '../environments';
import * as featureFlags from '../feature-flags';
import * as mcpConnections from '../mcp-connections';
import * as userApiKeys from '../user-api-keys';
import type { AppRouter, AppRouterInput, AppRouterOutput } from '../types';

export type { AppRouter, AppRouterInput, AppRouterOutput };
export type { GithubInstallation } from '../github-installations';
export type { SlackInstallation } from '../slack-installations';
export type { LinearSessionConnection } from '../linear-sessions';
export type { LinearInstallation } from '../linear-installations';
export type { Repository } from '../repositories';
export type { ParsedPR } from '../pull-request-links';
export type {
  TaskRun,
  DequeuedTaskRun,
  DequeuedResumeTaskRun,
} from '../task-runs';
export type { Environment, EnvironmentListItem } from '../environments';
export {
  detectPullRequestsFromToolResultEnvelope,
  parsePRFromOutput,
  parsePRsFromAuthoritativeToolResultOutput,
  parsePRsFromGhPrCheckoutToolResult,
  parsePRsFromGhPrCreateToolResult,
  parsePRsFromGhPrListToolResult,
  parsePRsFromText,
  parseRepoFromCommand,
} from '../pull-request-links';

export const sdk = {
  auth,
  githubInstallations,
  slackInstallations,
  linearInstallations,
  linearSessions,
  repositories,
  taskRuns,
  environments,
  featureFlags,
  mcpConnections,
  userApiKeys,
};

export interface CreateClientOptions {
  /**
   * The base URL for the tRPC API.
   * Defaults to TRPC_URL env var or http://localhost:3001
   */
  url?: string;
  /**
   * Function that returns headers to include with each request.
   * Use this to pass authentication tokens.
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

const WORKER_QUERY_RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const WORKER_QUERY_RETRY_MAX_ATTEMPTS = 4;
const WORKER_QUERY_RETRY_BASE_DELAY_MS = 250;

type FetchLike = typeof fetch;

export interface WorkerQueryRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

// The worker's first callbacks claim its job through the public edge, and a
// freshly (re)started proxy can briefly answer 5xx or without a JSON
// content-type before its upstreams settle. Claiming is idempotent server-side
// (FOR UPDATE SKIP LOCKED returns nothing on a second attempt), so these paths
// get a longer budget (~31s of backoff) instead of failing the whole job on
// one bad response.
const WORKER_STARTUP_MUTATION_RETRY_OPTIONS: WorkerQueryRetryOptions = {
  maxAttempts: 6,
  baseDelayMs: 1_000,
};

// Worker tRPC mutations that are safe to replay at the transport layer, with
// optional per-path overrides of the default retry budget.
const RETRYABLE_WORKER_TRPC_MUTATION_PATHS = new Map<
  string,
  WorkerQueryRetryOptions
>([
  ['taskRuns.recordMessageEnvelope', {}],
  ['taskRuns.dequeue', WORKER_STARTUP_MUTATION_RETRY_OPTIONS],
  ['taskRuns.resume', WORKER_STARTUP_MUTATION_RETRY_OPTIONS],
]);

function isQueryRequest(method?: string): boolean {
  return (method ?? 'GET').toUpperCase() === 'GET';
}

function resolveApiUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${normalizedBaseUrl}${normalizedPath}`;
}

function isPostRequest(method?: string): boolean {
  return (method ?? 'GET').toUpperCase() === 'POST';
}

function getRequestMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (init?.method) {
    return init.method;
  }

  return input instanceof Request ? input.method : 'GET';
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function getWorkerTrpcProcedurePaths(requestUrl: string): string[] {
  try {
    const pathname = new URL(requestUrl, 'http://localhost').pathname;
    const trpcPathIndex = pathname.indexOf('/trpc/');

    if (trpcPathIndex === -1) {
      return [];
    }

    return pathname
      .slice(trpcPathIndex + '/trpc/'.length)
      .split(',')
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
  } catch {
    return [];
  }
}

function isJsonContentType(contentType?: string | null): boolean {
  if (!contentType) {
    return false;
  }

  const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (!mimeType) {
    return false;
  }

  return mimeType === 'application/json' || mimeType.endsWith('+json');
}

async function assertValidWorkerTrpcResponse(
  response: Response,
  requestUrl: string,
): Promise<void> {
  const contentType = response.headers.get('content-type');
  if (isJsonContentType(contentType)) {
    return;
  }

  throw new Error(
    `Worker callback tRPC endpoint ${requestUrl} returned non-JSON content-type ${
      contentType ? JSON.stringify(contentType) : '"missing"'
    }.`,
  );
}

function shouldRetryWorkerQueryResponse(status: number): boolean {
  return WORKER_QUERY_RETRYABLE_STATUS_CODES.has(status);
}

type WorkerTrpcRetryPlan =
  | { retryable: false }
  | { retryable: true; maxAttempts: number; baseDelayMs: number };

function resolveWorkerTrpcRetryPlan(
  method: string,
  requestUrl: string,
): WorkerTrpcRetryPlan {
  if (isQueryRequest(method)) {
    return {
      retryable: true,
      maxAttempts: WORKER_QUERY_RETRY_MAX_ATTEMPTS,
      baseDelayMs: WORKER_QUERY_RETRY_BASE_DELAY_MS,
    };
  }

  if (!isPostRequest(method)) {
    return { retryable: false };
  }

  const procedurePaths = getWorkerTrpcProcedurePaths(requestUrl);

  if (procedurePaths.length === 0) {
    return { retryable: false };
  }

  // A batched request is only retryable when every procedure in it is, and the
  // smallest configured budget wins so batching never extends a path's budget.
  let maxAttempts = Infinity;
  let baseDelayMs = Infinity;

  for (const path of procedurePaths) {
    const overrides = RETRYABLE_WORKER_TRPC_MUTATION_PATHS.get(path);

    if (!overrides) {
      return { retryable: false };
    }

    maxAttempts = Math.min(
      maxAttempts,
      overrides.maxAttempts ?? WORKER_QUERY_RETRY_MAX_ATTEMPTS,
    );
    baseDelayMs = Math.min(
      baseDelayMs,
      overrides.baseDelayMs ?? WORKER_QUERY_RETRY_BASE_DELAY_MS,
    );
  }

  return { retryable: true, maxAttempts, baseDelayMs };
}

function getWorkerQueryRetryDelayMs(
  attemptNumber: number,
  baseDelayMs: number,
): number {
  return baseDelayMs * 2 ** (attemptNumber - 1);
}

export function createWorkerFetchWithRetry(
  baseFetch: FetchLike = globalThis.fetch.bind(globalThis),
  options: WorkerQueryRetryOptions = {},
): FetchLike {
  return async (input, init) => {
    const requestMethod = getRequestMethod(input, init);
    const requestUrl = getRequestUrl(input);
    const retryPlan = resolveWorkerTrpcRetryPlan(requestMethod, requestUrl);

    // Explicit wrapper options take precedence over per-path budgets so
    // callers (and tests) can pin the retry behavior.
    const maxAttempts =
      options.maxAttempts ??
      (retryPlan.retryable
        ? retryPlan.maxAttempts
        : WORKER_QUERY_RETRY_MAX_ATTEMPTS);
    const baseDelayMs =
      options.baseDelayMs ??
      (retryPlan.retryable
        ? retryPlan.baseDelayMs
        : WORKER_QUERY_RETRY_BASE_DELAY_MS);

    if (!retryPlan.retryable || maxAttempts <= 1) {
      const response = await baseFetch(input, init);

      await assertValidWorkerTrpcResponse(response, requestUrl);
      return response;
    }

    const response = await retryAsync(() => baseFetch(input, init), {
      maxAttempts,
      signal: init?.signal,
      getDelayMs: (attemptNumber) =>
        getWorkerQueryRetryDelayMs(attemptNumber, baseDelayMs),
      shouldRetry: ({ error, result }) => {
        if (error) {
          return true;
        }

        if (!result) {
          return false;
        }

        const contentType = result.headers.get('content-type');

        return (
          shouldRetryWorkerQueryResponse(result.status) ||
          !isJsonContentType(contentType)
        );
      },
    });

    await assertValidWorkerTrpcResponse(response, requestUrl);
    return response;
  };
}

/**
 * Create a tRPC client for calling the API.
 *
 * @example
 * // In a Next.js server action
 * const client = createClient({
 *   headers: async () => {
 *     const token = await getAuthToken();
 *     return { Authorization: `Bearer ${token}` };
 *   },
 * });
 *
 * const result = await client.taskRuns.createSnapshot.mutate({
 *   runId: 123,
 *   sandboxId: 'sandbox-abc',
 * });
 */
export function createClient(options: CreateClientOptions = {}) {
  const { url = process.env.TRPC_URL ?? 'http://localhost:3001', headers } =
    options;

  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: resolveApiUrl(url, '/trpc'),
        transformer: superjson,
        headers: headers ?? (() => ({})),
      }),
    ],
  });
}

function createWorkerLinkOptions() {
  return {
    url: resolveApiUrl(
      process.env.TRPC_URL ?? 'http://localhost:3001',
      '/trpc',
    ),
    transformer: superjson,
    headers: () => buildWorkerHeaders(),
    fetch: createWorkerFetchWithRetry(),
  };
}

export function buildWorkerHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (env.AUTH_TOKEN) {
    headers.Authorization = `Bearer ${env.AUTH_TOKEN}`;
  }

  const bypassValue = env.ROOMOTE_AUTH_BYPASS_VALUE?.trim();
  if (bypassValue) {
    const headerName =
      env.ROOMOTE_AUTH_BYPASS_HEADER_NAME?.trim().toLowerCase() ||
      DEFAULT_AUTH_BYPASS_HEADER_NAME;
    headers[headerName] = bypassValue;
  }

  return headers;
}

/**
 * Pre-configured client for worker processes that use AUTH_TOKEN env var.
 */
export const workerClient = createTRPCProxyClient<AppRouter>({
  links: [httpBatchLink(createWorkerLinkOptions())],
});

/**
 * Dedicated unbatched client for abort-sensitive worker mutations.
 */
export const workerHeartbeatClient = createTRPCProxyClient<AppRouter>({
  links: [
    // Heartbeats must abort their own transport even when other worker RPCs are
    // still in flight, so this path cannot share the batched link.
    httpLink(createWorkerLinkOptions()),
  ],
});

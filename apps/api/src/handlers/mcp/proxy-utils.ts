import { Hono } from 'hono';

import {
  filterMcpToolDefinitions,
  formatSingleLineLog,
  getEffectiveAllowedMcpToolNames,
  type JobTokenContext,
  isMcpToolAllowed,
  isUserToken,
  parseMcpJsonRpcPayload,
} from '@roomote/types';
import { resolveCredentialUserIdForCloudJob } from '@roomote/cloud-agents/server';
import { cloudJobs, db, eq } from '@roomote/db/server';

import type { Variables } from '../../types';
import { fetchWithLongLivedStreamDispatcher } from '../long-lived-fetch';
import { createLoggedProxyResponseBody } from '../proxy-response-stream';

type JsonRpcRequestId = string | number | null;

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  id: JsonRpcRequestId = null,
): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    },
    { status },
  );
}

function getJsonRpcRequestId(body: unknown): JsonRpcRequestId {
  if (!body || typeof body !== 'object' || !('id' in body)) {
    return null;
  }

  const { id } = body as { id?: unknown };
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export function isJobTokenContext(
  auth: Variables['authContext'],
): auth is JobTokenContext {
  return Boolean(auth && 'cloudJobId' in auth);
}

export function hasRealCloudJobUser(
  userId: string | null | undefined,
): userId is string {
  return typeof userId === 'string' && userId.trim().length > 0;
}

export function toMcpToolResult<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

/**
 * Resolve the effective user for downstream MCP credential lookup.
 *
 * Job tokens remain tied to the cloud job owner for authorization checks, but
 * integration MCPs may need to execute as the most recent human who replied to
 * the task. That live actor is stored on `cloud_jobs.actingUserId` rather than
 * inferred from `task_messages`, because transcript persistence is async and
 * may lag behind the turn that is about to make MCP calls.
 */
export async function resolveActingUserId(
  auth: McpAuthContext,
): Promise<string> {
  if (auth.tokenType !== 'cj') {
    return auth.userId;
  }

  if (!auth.cloudJobId) {
    throw new McpProxyError(
      403,
      'MCP proxy requires a cloud job token with a cloud job id',
    );
  }

  const cloudJob = await db.query.cloudJobs.findFirst({
    columns: { userId: true, actingUserId: true },
    where: eq(cloudJobs.id, auth.cloudJobId),
  });

  if (!cloudJob) {
    throw new McpProxyError(404, 'Cloud job not found for this MCP token');
  }

  const resolvedUserId = await resolveCredentialUserIdForCloudJob({
    id: auth.cloudJobId,
    userId: cloudJob.userId,
  });

  if (!hasRealCloudJobUser(resolvedUserId)) {
    throw new McpProxyError(
      403,
      'MCP proxy requires a cloud job associated with a real user',
    );
  }

  return cloudJob.actingUserId ?? resolvedUserId;
}

async function verifyCloudJobHasRealUser(
  auth: JobTokenContext,
): Promise<Response | null> {
  const cloudJob = await db.query.cloudJobs.findFirst({
    columns: { id: true, userId: true },
    where: eq(cloudJobs.id, auth.cloudJobId),
  });

  if (!cloudJob) {
    return jsonRpcErrorResponse(
      404,
      -32000,
      'Cloud job not found for this MCP token',
    );
  }

  const resolvedUserId = await resolveCredentialUserIdForCloudJob(cloudJob);

  if (!hasRealCloudJobUser(resolvedUserId)) {
    return jsonRpcErrorResponse(
      403,
      -32000,
      'MCP proxy requires a cloud job associated with a real user',
    );
  }

  if (resolvedUserId !== auth.userId) {
    return jsonRpcErrorResponse(
      403,
      -32000,
      'MCP token user does not match cloud job user',
    );
  }

  return null;
}

export async function assertCloudJobTokenMatchesCloudJobUser(
  auth: JobTokenContext,
): Promise<void> {
  const validationError = await verifyCloudJobHasRealUser(auth);

  if (!validationError) {
    return;
  }

  let message = 'Cloud job token validation failed';
  try {
    const body = (await validationError.clone().json()) as {
      error?: { message?: string };
    };
    if (typeof body.error?.message === 'string' && body.error.message.length) {
      message = body.error.message;
    }
  } catch {
    // Ignore malformed JSON-RPC error bodies and fall back to the default message.
  }

  throw new McpProxyError(validationError.status, message);
}

function buildProxyRequestHeaders(
  authHeader: string,
  requestHeaders: Headers,
  method: string,
): Headers {
  const headers = new Headers();

  if (method === 'POST') {
    headers.set('content-type', 'application/json');
  }
  headers.set(
    'accept',
    requestHeaders.get('accept') ?? 'application/json, text/event-stream',
  );
  headers.set(
    'authorization',
    authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`,
  );

  const sessionId = requestHeaders.get('mcp-session-id');
  if (sessionId) {
    headers.set('mcp-session-id', sessionId);
  }

  const protocolVersion = requestHeaders.get('mcp-protocol-version');
  if (protocolVersion) {
    headers.set('mcp-protocol-version', protocolVersion);
  }

  return headers;
}

function buildProxyResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();

  const excludedHeaders = new Set([
    'connection',
    // Node fetch transparently decodes compressed upstream bodies, so forwarding
    // this header makes downstream clients try to decode the plain body again.
    'content-encoding',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);

  for (const [key, value] of upstreamHeaders.entries()) {
    if (!excludedHeaders.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  return headers;
}

function isJsonResponse(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }

  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (!mediaType) {
    return false;
  }

  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

interface ResolvedCredentials {
  authHeader: string;
  extraHeaders?: Record<string, string>;
  disabledToolNames?: readonly string[] | null;
}

export interface McpAuthContext {
  userId: string;
  tokenType: 'cj' | 'auth';
  cloudJobId?: number;
}

interface McpProxyConfig {
  name: string;
  upstream: string;
  resolveCredentials: (auth: McpAuthContext) => Promise<ResolvedCredentials>;
  allowAuthTokens?: boolean;
  validateCloudJobToken?: (auth: JobTokenContext) => Promise<Response | null>;
  allowedToolNames?: readonly string[];
  timeoutMs?: number;
}

export class McpProxyError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpProxyError';
  }
}

type JsonRpcRequestLike = {
  method?: unknown;
  params?: unknown;
};

function getJsonRpcMethod(request: unknown): string | null {
  if (!request || typeof request !== 'object' || !('method' in request)) {
    return null;
  }

  const method = (request as JsonRpcRequestLike).method;
  return typeof method === 'string' ? method : null;
}

function getToolCallName(request: unknown): string | null {
  if (
    !request ||
    typeof request !== 'object' ||
    (request as JsonRpcRequestLike).method !== 'tools/call'
  ) {
    return null;
  }

  const params = (request as JsonRpcRequestLike).params;
  if (!params || typeof params !== 'object' || !('name' in params)) {
    return null;
  }

  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function isExpectedProxyDisconnect(error: unknown): error is DOMException {
  return (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function filterToolsListPayload(
  payload: unknown,
  toolPolicy: {
    allowedToolNames?: readonly string[];
    disabledToolNames?: readonly string[] | null;
  },
): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  if (
    !('result' in payload) ||
    !payload.result ||
    typeof payload.result !== 'object'
  ) {
    return payload;
  }

  const result = payload.result as { tools?: unknown };
  if (!Array.isArray(result.tools)) {
    return payload;
  }

  const namedTools = result.tools.filter(
    (toolDef): toolDef is { name: string } & Record<string, unknown> =>
      Boolean(
        toolDef &&
        typeof toolDef === 'object' &&
        'name' in toolDef &&
        typeof toolDef.name === 'string',
      ),
  );

  return {
    ...payload,
    result: {
      ...result,
      tools: filterMcpToolDefinitions(namedTools, toolPolicy),
    },
  };
}

export function createMcpProxy(config: McpProxyConfig) {
  const {
    name,
    upstream,
    resolveCredentials,
    timeoutMs = 30_000,
    allowAuthTokens = false,
    validateCloudJobToken = verifyCloudJobHasRealUser,
    allowedToolNames,
  } = config;

  const app = new Hono<{ Variables: Variables }>();

  app.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
    const startedAt = Date.now();
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const requestId = crypto.randomUUID();
    const logPrefix = `[MCP Proxy:${name}]`;
    const rawAuth = c.get('authContext');

    if (!rawAuth) {
      console.warn(
        formatSingleLineLog(`${logPrefix} Missing auth context`, {
          requestId,
          method,
          path,
        }),
      );
      return jsonRpcErrorResponse(
        401,
        -32001,
        'Unauthorized: missing or invalid bearer token',
      );
    }

    let auth: McpAuthContext;

    if (isJobTokenContext(rawAuth)) {
      const cloudJobValidationError = await validateCloudJobToken(rawAuth);
      if (cloudJobValidationError) {
        console.warn(
          formatSingleLineLog(`${logPrefix} Cloud job auth validation failed`, {
            requestId,
            method,
            path,
            tokenType: rawAuth.tokenType,
            cloudJobId: rawAuth.cloudJobId,
            userId: rawAuth.userId,
            status: cloudJobValidationError.status,
          }),
        );
        return cloudJobValidationError;
      }

      auth = {
        userId: rawAuth.userId,
        tokenType: 'cj',
        cloudJobId: rawAuth.cloudJobId,
      };
    } else if (allowAuthTokens && isUserToken(rawAuth)) {
      auth = {
        userId: rawAuth.userId,
        tokenType: 'auth',
      };
    } else {
      console.warn(
        formatSingleLineLog(
          `${logPrefix} Unsupported token type for endpoint`,
          {
            requestId,
            method,
            path,
            allowAuthTokens,
          },
        ),
      );
      return jsonRpcErrorResponse(
        403,
        -32000,
        allowAuthTokens
          ? `${name} MCP requires a user-scoped auth token or cloud job token`
          : `${name} MCP is only available for cloud job tokens`,
      );
    }

    let upstreamBody: string | undefined;
    let parsedBody: unknown;

    if (method === 'POST') {
      try {
        parsedBody = await c.req.json();
        upstreamBody = JSON.stringify(parsedBody);
      } catch {
        console.warn(
          formatSingleLineLog(`${logPrefix} Invalid JSON request body`, {
            requestId,
            method,
            path,
            tokenType: auth.tokenType,
            userId: auth.userId,
          }),
        );
        return jsonRpcErrorResponse(400, -32700, 'Invalid JSON body');
      }
    }

    let credentials: ResolvedCredentials;

    try {
      credentials = await resolveCredentials(auth);
    } catch (error) {
      console.warn(
        formatSingleLineLog(`${logPrefix} Failed to resolve credentials`, {
          requestId,
          method,
          path,
          tokenType: auth.tokenType,
          userId: auth.userId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (error instanceof McpProxyError) {
        return jsonRpcErrorResponse(error.httpStatus, -32000, error.message);
      }
      return jsonRpcErrorResponse(
        500,
        -32603,
        `Failed to resolve ${name} credentials: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      const effectiveAllowedToolNames = getEffectiveAllowedMcpToolNames({
        allowedToolNames,
        disabledToolNames: credentials.disabledToolNames,
      });
      const hasToolRestrictions = Boolean(
        effectiveAllowedToolNames || credentials.disabledToolNames?.length,
      );

      if (
        hasToolRestrictions &&
        method === 'POST' &&
        Array.isArray(parsedBody)
      ) {
        console.warn(
          formatSingleLineLog(`${logPrefix} Rejected batch JSON-RPC request`, {
            requestId,
            method,
            path,
            tokenType: auth.tokenType,
            userId: auth.userId,
          }),
        );
        return jsonRpcErrorResponse(
          400,
          -32600,
          `${name} MCP batch JSON-RPC requests are not allowed on this endpoint`,
        );
      }

      if (hasToolRestrictions && method === 'POST') {
        const toolName = getToolCallName(parsedBody);
        if (
          toolName &&
          !isMcpToolAllowed(toolName, {
            allowedToolNames,
            disabledToolNames: credentials.disabledToolNames,
          })
        ) {
          console.warn(
            formatSingleLineLog(
              `${logPrefix} Rejected disallowed MCP tool call`,
              {
                requestId,
                method,
                path,
                tokenType: auth.tokenType,
                userId: auth.userId,
                toolName,
              },
            ),
          );
          return jsonRpcErrorResponse(
            403,
            -32000,
            `${name} MCP tool "${toolName}" is not allowed on this endpoint`,
            getJsonRpcRequestId(parsedBody),
          );
        }
      }

      const proxyHeaders = buildProxyRequestHeaders(
        credentials.authHeader,
        c.req.raw.headers,
        method,
      );

      if (credentials.extraHeaders) {
        for (const [key, value] of Object.entries(credentials.extraHeaders)) {
          proxyHeaders.set(key, value);
        }
      }

      const isLongLivedStreamableTransportRequest =
        method === 'GET' || method === 'POST';

      const signal = isLongLivedStreamableTransportRequest
        ? c.req.raw.signal
        : AbortSignal.any([
            AbortSignal.timeout(timeoutMs),
            ...(c.req.raw.signal ? [c.req.raw.signal] : []),
          ]);

      const upstreamRequestInit = {
        method,
        headers: proxyHeaders,
        body: upstreamBody,
        signal,
      };

      const upstreamResponse = isLongLivedStreamableTransportRequest
        ? await fetchWithLongLivedStreamDispatcher(
            upstream,
            upstreamRequestInit,
          )
        : await fetch(upstream, upstreamRequestInit);

      const elapsedMs = Date.now() - startedAt;
      const contentType = upstreamResponse.headers.get('content-type');

      if (!upstreamResponse.ok) {
        console.warn(
          formatSingleLineLog(`${logPrefix} Upstream returned non-OK status`, {
            requestId,
            method,
            path,
            upstream,
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            contentType,
            elapsedMs,
          }),
        );
      }

      if (
        hasToolRestrictions &&
        method === 'POST' &&
        getJsonRpcMethod(parsedBody) === 'tools/list' &&
        upstreamResponse.ok
      ) {
        try {
          const payload = parseMcpJsonRpcPayload(
            await upstreamResponse.clone().text(),
            upstreamResponse.headers.get('content-type'),
          );
          if (!payload) {
            throw new Error('Unable to parse upstream tools/list payload');
          }
          const filteredPayload = filterToolsListPayload(payload, {
            allowedToolNames: effectiveAllowedToolNames,
            disabledToolNames: credentials.disabledToolNames,
          });
          const headers = buildProxyResponseHeaders(upstreamResponse.headers);
          headers.set('content-type', 'application/json');

          return new Response(JSON.stringify(filteredPayload), {
            status: upstreamResponse.status,
            headers,
          });
        } catch {
          // Fall through to the raw upstream response if the body is not JSON.
        }
      }

      if (method === 'POST' && isJsonResponse(contentType)) {
        return new Response(await upstreamResponse.text(), {
          status: upstreamResponse.status,
          headers: buildProxyResponseHeaders(upstreamResponse.headers),
        });
      }

      return new Response(
        createLoggedProxyResponseBody({
          body: upstreamResponse.body,
          logPrefix: `${logPrefix} Upstream response stream failed`,
          getLogFields: () => ({
            requestId,
            method,
            path,
            upstream,
            status: upstreamResponse.status,
            tokenType: auth.tokenType,
            userId: auth.userId,
            elapsedMs: Date.now() - startedAt,
          }),
          trackingContext: {
            route: `mcp:${name}`,
            method,
            path,
            requestId,
          },
        }),
        {
          status: upstreamResponse.status,
          headers: buildProxyResponseHeaders(upstreamResponse.headers),
        },
      );
    } catch (error) {
      const logDetails = {
        requestId,
        method,
        path,
        upstream,
        tokenType: auth.tokenType,
        userId: auth.userId,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      if (isExpectedProxyDisconnect(error)) {
        console.debug(`${logPrefix} Upstream fetch failed`, logDetails);
      } else {
        console.error(`${logPrefix} Upstream fetch failed`, logDetails);
      }
      return jsonRpcErrorResponse(
        502,
        -32603,
        `Failed to proxy ${name} MCP request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  app.all('/', () => {
    return jsonRpcErrorResponse(405, -32000, 'Method not allowed');
  });

  return app;
}

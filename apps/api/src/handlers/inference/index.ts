import { Hono } from 'hono';

import { formatSingleLineLog } from '@roomote/types';
import {
  db,
  eq,
  resolveModelProviderEnvValue,
  taskRuns,
} from '@roomote/db/server';

import type { Variables } from '../../types';
import { fetchWithLongLivedStreamDispatcher } from '../long-lived-fetch';
import { createLoggedProxyResponseBody } from '../proxy-response-stream';
import {
  buildProxyResponseHeaders,
  isRunTokenContext,
} from '../mcp/proxy-utils';
import {
  formatProviderAuthHeaderValue,
  getInferenceProvider,
  isInferencePathAllowed,
  resolveProviderUpstreamBaseUrl,
} from './registry';

/**
 * Client headers never forwarded upstream. The client's own credential
 * headers (its bearer token is the Roomote run token) are replaced with the
 * provider key; hop-by-hop and proxy-added routing headers are dropped so the
 * upstream sees a clean direct request.
 */
const REQUEST_HEADER_DENYLIST = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

function buildUpstreamRequestHeaders(
  requestHeaders: Headers,
  authHeaderName: string,
  authHeaderValue: string,
): Headers {
  const headers = new Headers();

  for (const [key, value] of requestHeaders.entries()) {
    if (!REQUEST_HEADER_DENYLIST.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  headers.set(authHeaderName, authHeaderValue);

  return headers;
}

/**
 * The upstream path is everything after the provider segment. The router
 * only matches `/:provider/*`, so the marker is always present.
 */
function extractUpstreamPath(pathname: string, providerId: string): string {
  const marker = `/${providerId}/`;
  const markerIndex = pathname.indexOf(marker);

  return markerIndex === -1
    ? ''
    : pathname.slice(markerIndex + marker.length - 1);
}

/**
 * Inference gateway: forwards LLM API traffic from task sandboxes to model
 * providers, injecting the deployment's provider key server-side. Sandboxes
 * authenticate with their run-scoped token and never hold the key itself.
 *
 * Requests stream through in both directions; inference responses are
 * long-lived SSE streams, so upstream fetches use the no-body-timeout
 * dispatcher and rely on caller disconnects for cleanup.
 */
export const inference = new Hono<{ Variables: Variables }>();

inference.on(['POST', 'GET'], '/:provider/*', async (c) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const method = c.req.method;
  const providerId = c.req.param('provider');
  const pathname = new URL(c.req.url).pathname;
  const logPrefix = `[Inference Gateway:${providerId}]`;

  const auth = c.get('authContext');

  if (!auth || !isRunTokenContext(auth)) {
    return c.json(
      { error: 'The inference gateway requires a task run token' },
      403,
    );
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: { id: true },
    where: eq(taskRuns.id, auth.runId),
  });

  if (!taskRun) {
    return c.json({ error: 'Task run not found for this token' }, 404);
  }

  const provider = getInferenceProvider(providerId);

  if (!provider) {
    return c.json({ error: `Unknown inference provider "${providerId}"` }, 404);
  }

  const upstreamPath = extractUpstreamPath(pathname, providerId);

  if (!isInferencePathAllowed(provider, upstreamPath)) {
    console.warn(
      formatSingleLineLog(`${logPrefix} Rejected disallowed upstream path`, {
        requestId,
        method,
        runId: auth.runId,
        upstreamPath,
      }),
    );

    return c.json(
      {
        error: `Path is not allowed through the ${provider.name} inference gateway`,
      },
      403,
    );
  }

  let apiKey: string | undefined;
  let upstreamBaseUrl: string;

  try {
    apiKey = await resolveModelProviderEnvValue(provider.envVarNames);
    upstreamBaseUrl = await resolveProviderUpstreamBaseUrl(provider);
  } catch (error) {
    console.error(
      formatSingleLineLog(`${logPrefix} Failed to resolve provider config`, {
        requestId,
        method,
        runId: auth.runId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return c.json(
      { error: `Failed to resolve the ${provider.name} configuration` },
      500,
    );
  }

  if (!apiKey) {
    return c.json(
      {
        error: `No ${provider.name} API key is configured for this deployment`,
      },
      404,
    );
  }

  const search = new URL(c.req.url).search;
  const upstreamUrl = `${upstreamBaseUrl}${upstreamPath}${search}`;

  try {
    const upstreamResponse = await fetchWithLongLivedStreamDispatcher(
      upstreamUrl,
      {
        method,
        headers: buildUpstreamRequestHeaders(
          c.req.raw.headers,
          provider.authHeader.name,
          formatProviderAuthHeaderValue(provider, apiKey),
        ),
        body: c.req.raw.body,
        signal: c.req.raw.signal,
        // Required by undici when streaming a request body.
        ...(c.req.raw.body ? { duplex: 'half' as const } : {}),
      },
    );

    if (!upstreamResponse.ok) {
      console.warn(
        formatSingleLineLog(`${logPrefix} Upstream returned non-OK status`, {
          requestId,
          method,
          runId: auth.runId,
          upstreamPath,
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }

    return new Response(
      createLoggedProxyResponseBody({
        body: upstreamResponse.body,
        logPrefix: `${logPrefix} Upstream response stream failed`,
        getLogFields: () => ({
          requestId,
          method,
          runId: auth.runId,
          upstreamPath,
          status: upstreamResponse.status,
          elapsedMs: Date.now() - startedAt,
        }),
        trackingContext: {
          route: `inference:${providerId}`,
          method,
          path: pathname,
          requestId,
        },
      }),
      {
        status: upstreamResponse.status,
        headers: buildProxyResponseHeaders(upstreamResponse.headers),
      },
    );
  } catch (error) {
    console.error(
      formatSingleLineLog(`${logPrefix} Upstream fetch failed`, {
        requestId,
        method,
        runId: auth.runId,
        upstreamPath,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return c.json({ error: `Failed to reach the ${provider.name} API` }, 502);
  }
});

inference.all('/:provider/*', (c) =>
  c.json({ error: 'Method not allowed' }, 405),
);

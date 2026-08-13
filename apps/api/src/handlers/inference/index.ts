import { Hono } from 'hono';

import {
  formatSingleLineLog,
  rewriteCloudflareAiGatewayRequestBody,
} from '@roomote/types';
import { db, eq, taskRuns } from '@roomote/db/server';
import { recordLlmUsage } from '@roomote/sdk/server';

import type { Variables } from '../../types';
import { fetchWithLongLivedStreamDispatcher } from '../long-lived-fetch';
import { createLoggedProxyResponseBody } from '../proxy-response-stream';
import {
  buildProxyResponseHeaders,
  isRunTokenContext,
} from '../mcp/proxy-utils';
import {
  getInferenceProvider,
  isInferencePathAllowed,
  resolveGatewayUpstream,
  type GatewayUpstreamResolution,
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
  // The gateway sets the ChatGPT account-id authoritatively from the OAuth
  // record; a sandbox must not be able to smuggle its own.
  'chatgpt-account-id',
  // Copilot request classification is set authoritatively by the gateway.
  'openai-intent',
  'x-initiator',
  'copilot-vision-request',
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

function recordLiteLlmResponseCost(options: {
  requestId: string;
  runId: number;
  headers: Headers;
}): void {
  const cost = Number(options.headers.get('x-litellm-response-cost'));

  if (!Number.isFinite(cost) || cost <= 0) {
    return;
  }

  const modelGroup = options.headers.get('x-litellm-model-group')?.trim();

  void db.query.taskRuns
    .findFirst({
      where: eq(taskRuns.id, options.runId),
      columns: { taskId: true },
    })
    .then((run) => {
      if (!run?.taskId) {
        return undefined;
      }

      return recordLlmUsage({
        eventKey: `inference-gateway:${options.requestId}`,
        source: 'inference-gateway',
        usageType: 'inference',
        taskId: run.taskId,
        runId: options.runId,
        providerId: 'litellm',
        modelId: modelGroup ? `litellm/${modelGroup}` : null,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
        contextTokens: null,
        costMicroUsd: Math.round(cost * 1_000_000),
        costSource: 'litellm_gateway',
      });
    })
    .catch((error) => {
      console.warn(
        formatSingleLineLog('Failed to record LiteLLM response cost', {
          requestId: options.requestId,
          runId: options.runId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
}

function buildUpstreamRequestHeaders(
  requestHeaders: Headers,
  injectedHeaders: Record<string, string>,
): Headers {
  const headers = new Headers();

  for (const [key, value] of requestHeaders.entries()) {
    if (!REQUEST_HEADER_DENYLIST.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(injectedHeaders)) {
    headers.set(key, value);
  }

  return headers;
}

function buildInferenceResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = buildProxyResponseHeaders(upstreamHeaders);

  if (
    !headers.get('content-type')?.toLowerCase().includes('text/event-stream')
  ) {
    return headers;
  }

  const cacheControl = headers.get('cache-control');
  const directives =
    cacheControl?.split(',').map((directive) => directive.trim()) ?? [];

  // Keep intermediaries from compressing provider SSE. OpenCode's Bun runtime
  // can otherwise complete the request without exposing any stream events.
  if (
    !directives.some((directive) => directive.toLowerCase() === 'no-transform')
  ) {
    headers.set(
      'cache-control',
      [...directives, 'no-transform'].filter(Boolean).join(', '),
    );
  }

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
 * Mirror OpenCode's GitHub Copilot vision detection so gateway-mode requests
 * set `Copilot-Vision-Request` when the body carries image content across the
 * common OpenAI, Responses, and Anthropic-compatible shapes.
 */
function copilotRequestBodyHasVisionContent(bodyText: string): boolean {
  if (!bodyText.trim()) {
    return false;
  }

  let body: unknown;

  try {
    body = JSON.parse(bodyText);
  } catch {
    return false;
  }

  if (!body || typeof body !== 'object') {
    return false;
  }

  const record = body as {
    messages?: unknown;
    input?: unknown;
  };

  if (
    Array.isArray(record.messages) &&
    messagesContainVisionContent(record.messages)
  ) {
    return true;
  }

  if (Array.isArray(record.input) && inputContainsVisionContent(record.input)) {
    return true;
  }

  return false;
}

function messagesContainVisionContent(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== 'object') {
      return false;
    }

    const content = (message as { content?: unknown }).content;

    if (!Array.isArray(content)) {
      return false;
    }

    return content.some((part) => {
      if (!part || typeof part !== 'object') {
        return false;
      }

      const typed = part as {
        type?: unknown;
        content?: unknown;
      };

      if (typed.type === 'image_url' || typed.type === 'image') {
        return true;
      }

      // Anthropic-style images can nest under tool_result content.
      if (typed.type === 'tool_result' && Array.isArray(typed.content)) {
        return typed.content.some(
          (nested) =>
            nested &&
            typeof nested === 'object' &&
            (nested as { type?: unknown }).type === 'image',
        );
      }

      return false;
    });
  });
}

function inputContainsVisionContent(input: unknown[]): boolean {
  return input.some((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }

    const content = (item as { content?: unknown }).content;

    if (!Array.isArray(content)) {
      return false;
    }

    return content.some(
      (part) =>
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'input_image',
    );
  });
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

  const search = new URL(c.req.url).search;

  let resolution: GatewayUpstreamResolution;

  try {
    resolution = await resolveGatewayUpstream(provider, upstreamPath, search);
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

  if (!resolution.ok) {
    return c.json({ error: resolution.error }, resolution.status);
  }

  const { upstreamUrl, headers: injectedHeaders } = resolution.resolved;

  if (providerId === 'github-copilot') {
    injectedHeaders['x-initiator'] =
      c.req.header('x-initiator') === 'agent' ? 'agent' : 'user';
  }

  // GitHub Copilot's OAuth path normally labels vision traffic. Gateway mode
  // holds that token server-side, so inspect the request body here and restore
  // the same header OpenCode would have set.
  let requestBody: BodyInit | null = c.req.raw.body;
  let useDuplexHalf = Boolean(c.req.raw.body);

  if (providerId === 'github-copilot' && method === 'POST') {
    const bodyText = await c.req.text();
    requestBody = bodyText;
    useDuplexHalf = false;

    if (copilotRequestBodyHasVisionContent(bodyText)) {
      injectedHeaders['Copilot-Vision-Request'] = 'true';
    }
  }

  if (providerId === 'cloudflare-ai-gateway' && method === 'POST') {
    const bodyText = await c.req.text();
    requestBody = rewriteCloudflareAiGatewayRequestBody(bodyText);
    useDuplexHalf = false;
  }

  try {
    const upstreamResponse = await fetchWithLongLivedStreamDispatcher(
      upstreamUrl,
      {
        method,
        headers: buildUpstreamRequestHeaders(
          c.req.raw.headers,
          injectedHeaders,
        ),
        body: requestBody,
        signal: c.req.raw.signal,
        // Required by undici when streaming a request body.
        ...(useDuplexHalf ? { duplex: 'half' as const } : {}),
      },
    );

    if (providerId === 'litellm') {
      recordLiteLlmResponseCost({
        requestId,
        runId: auth.runId,
        headers: upstreamResponse.headers,
      });
    }

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
        headers: buildInferenceResponseHeaders(upstreamResponse.headers),
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

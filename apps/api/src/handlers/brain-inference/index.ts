import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import {
  formatSingleLineLog,
  getInferenceGatewayProvider,
} from '@roomote/types';
import {
  getBrainGatewayToken,
  mapBrainModelName,
  recordLlmUsage,
  resolveBrainInferenceProvider,
  type ResolvedBrainInference,
} from '@roomote/sdk/server';

import type { Variables } from '../../types';

const LOG_PREFIX = '[Brain Inference]';

/**
 * The Brain's whole inference surface: embeddings for recall, reranking for
 * precision, and chat for sourced synthesis and query expansion. Deliberately
 * narrower than the task-sandbox gateway's allowlist, because this credential
 * is a static deployment secret rather than a short-lived run token.
 */
const BRAIN_ALLOWED_PATHS = new Set([
  '/v1/embeddings',
  '/v1/rerank',
  '/v1/chat/completions',
  '/v1/responses',
]);

/** Never forwarded upstream: the Brain's gateway token is not a provider key. */
const REQUEST_HEADER_DENYLIST = new Set([
  'authorization',
  'x-api-key',
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

const RESPONSE_HEADER_DENYLIST = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

type BrainInferenceOperation = {
  name: 'embeddings' | 'rerank' | 'chat_completions' | 'responses';
  usageType: 'embedding' | 'rerank' | 'inference';
};

type ProviderUsage = {
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costDetails: Record<string, unknown> | null;
};

function resolveOperation(upstreamPath: string): BrainInferenceOperation {
  if (upstreamPath === '/v1/embeddings') {
    return { name: 'embeddings', usageType: 'embedding' };
  }

  if (upstreamPath === '/v1/rerank') {
    return { name: 'rerank', usageType: 'rerank' };
  }

  return {
    name: upstreamPath === '/v1/responses' ? 'responses' : 'chat_completions',
    usageType: 'inference',
  };
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findUsageEnvelope(body: string): Record<string, unknown> | null {
  const candidates = [body];

  if (body.includes('\ndata:')) {
    candidates.push(
      ...body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .filter((line) => line && line !== '[DONE]'),
    );
  }

  for (const candidate of candidates.reverse()) {
    try {
      const envelope = objectValue(JSON.parse(candidate));
      const response = objectValue(envelope?.response);

      if (objectValue(envelope?.usage)) {
        return envelope;
      }

      if (objectValue(response?.usage)) {
        return response;
      }
    } catch {
      // Provider errors and streaming sentinels are not necessarily JSON.
    }
  }

  return null;
}

function parseProviderUsage(body: string): ProviderUsage | null {
  const envelope = findUsageEnvelope(body);
  const usage = objectValue(envelope?.usage);

  if (!usage) {
    return null;
  }

  const inputDetails =
    objectValue(usage.prompt_tokens_details) ??
    objectValue(usage.input_tokens_details);
  const outputDetails =
    objectValue(usage.completion_tokens_details) ??
    objectValue(usage.output_tokens_details);

  return {
    modelId: typeof envelope?.model === 'string' ? envelope.model : null,
    inputTokens:
      finiteNonNegative(usage.prompt_tokens) ??
      finiteNonNegative(usage.input_tokens),
    outputTokens:
      finiteNonNegative(usage.completion_tokens) ??
      finiteNonNegative(usage.output_tokens),
    reasoningTokens:
      finiteNonNegative(usage.reasoning_tokens) ??
      finiteNonNegative(outputDetails?.reasoning_tokens),
    cacheReadTokens:
      finiteNonNegative(usage.cache_read_tokens) ??
      finiteNonNegative(inputDetails?.cached_tokens),
    cacheWriteTokens: finiteNonNegative(usage.cache_write_tokens),
    totalTokens: finiteNonNegative(usage.total_tokens),
    costUsd: finiteNonNegative(usage.cost),
    costDetails: objectValue(usage.cost_details),
  };
}

function recordBrainInferenceUsage(input: {
  requestId: string;
  providerId: ResolvedBrainInference['providerId'];
  modelId: string | null;
  operation: BrainInferenceOperation;
  upstreamPath: string;
  status: number;
  startedAt: number;
  response?: Response;
}): void {
  const persist = async () => {
    let usage: ProviderUsage | null = null;
    let metadataReadFailed = false;

    if (input.response) {
      try {
        usage = parseProviderUsage(await input.response.text());
      } catch {
        metadataReadFailed = true;
      }
    }

    const costMicroUsd =
      usage?.costUsd === null || usage?.costUsd === undefined
        ? null
        : Math.round(usage.costUsd * 1_000_000);

    await recordLlmUsage({
      eventKey: `brain-inference-gateway:${input.requestId}`,
      source: 'brain-inference-gateway',
      usageType: input.operation.usageType,
      providerId: input.providerId,
      modelId: usage?.modelId ?? input.modelId,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheWriteTokens: usage?.cacheWriteTokens,
      totalTokens: usage?.totalTokens,
      contextTokens: usage?.inputTokens,
      costMicroUsd,
      costSource: costMicroUsd === null ? 'missing' : 'provider_response',
      pricingMetadata: usage?.costDetails
        ? { costDetails: usage.costDetails }
        : undefined,
      details: {
        operation: input.operation.name,
        upstreamPath: input.upstreamPath,
        status: input.status,
        latencyMs: Date.now() - input.startedAt,
        usageMetadataAvailable: usage !== null,
        metadataReadFailed,
      },
    });
  };

  void persist().catch((error) => {
    console.warn(
      formatSingleLineLog(`${LOG_PREFIX} Failed to record usage`, {
        requestId: input.requestId,
        providerId: input.providerId,
        upstreamPath: input.upstreamPath,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

function presentedToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
}

/** Constant-time compare that does not leak length through early return. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  if (a.length !== b.length) {
    // Still burn a comparison so a wrong-length guess is not measurably
    // faster than a right-length one.
    timingSafeEqual(a, a);
    return false;
  }

  return timingSafeEqual(a, b);
}

/**
 * Rewrite the requested model into the resolved provider's naming. The Brain
 * always speaks OpenAI model names because it is configured as an
 * OpenAI-compatible client; the deployment may be routing through OpenRouter,
 * which namespaces the same models by vendor.
 */
async function rewriteBody(
  rawBody: string,
  resolved: ResolvedBrainInference,
  upstreamPath: string,
): Promise<string> {
  if (!rawBody) {
    return rawBody;
  }

  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;

    if (typeof parsed.model !== 'string') {
      return rawBody;
    }

    const rewritten: Record<string, unknown> = {
      ...parsed,
      model: mapBrainModelName(parsed.model, resolved),
    };

    // OpenAI-compatible chat streams omit usage unless explicitly requested.
    // Preserve any existing stream options while asking supported providers to
    // include the final usage-only chunk for asynchronous accounting.
    if (upstreamPath === '/v1/chat/completions' && parsed.stream === true) {
      rewritten.stream_options = {
        ...(objectValue(parsed.stream_options) ?? {}),
        include_usage: true,
      };
    }

    return JSON.stringify(rewritten);
  } catch {
    // Not JSON we understand; forward untouched rather than failing the call.
    return rawBody;
  }
}

/**
 * Inference gateway for this deployment's Brain.
 *
 * The Brain container holds no provider credential. It is pointed at this
 * route with a shared gateway token, and Roomote injects whichever provider
 * key an admin configured, resolved per request. That is what makes the
 * Brain's credential a Settings value rather than a container environment
 * variable: rotating or switching it takes effect on the next call, with no
 * redeploy and no key ever present in the Brain.
 *
 * The route authenticates its own caller (policy class `webhook`): the token
 * is a deployment secret shared with exactly one sibling service.
 */
export const brainInference = new Hono<{ Variables: Variables }>();

brainInference.post('/*', async (c) => {
  const expectedToken = getBrainGatewayToken();

  if (!expectedToken) {
    // No token configured means no Brain is wired to this deployment. Closed
    // rather than open: an unauthenticated request must never reach a
    // provider key.
    return c.json({ error: 'The Brain inference gateway is not enabled' }, 404);
  }

  const presented = presentedToken(c.req.header('authorization'));

  if (!presented || !tokenMatches(presented, expectedToken)) {
    return c.json({ error: 'Invalid Brain gateway token' }, 401);
  }

  const requestUrl = new URL(c.req.url);
  const upstreamPath = requestUrl.pathname.replace(
    /^\/api\/brain\/inference/,
    '',
  );

  if (!BRAIN_ALLOWED_PATHS.has(upstreamPath)) {
    console.warn(
      formatSingleLineLog(`${LOG_PREFIX} Rejected disallowed path`, {
        upstreamPath,
      }),
    );

    return c.json({ error: 'Path is not allowed through this gateway' }, 403);
  }

  const resolved = await resolveBrainInferenceProvider();

  if (!resolved) {
    // A deployed but unconfigured Brain lands here. 503 rather than 500: the
    // deployment is healthy, it just has no model provider configured yet.
    return c.json(
      {
        error:
          'No model provider is configured for this deployment. Add a provider key in Settings to enable the Brain.',
      },
      503,
    );
  }

  // gbrain's OpenRouter reranker speaks the same authenticated gateway
  // contract as embeddings and chat, but OpenAI itself has no compatible
  // rerank endpoint. Fail explicitly instead of forwarding a doomed request
  // to api.openai.com and obscuring the missing capability as a 404.
  if (upstreamPath === '/v1/rerank' && resolved.providerId !== 'openrouter') {
    return c.json(
      {
        error:
          'Brain reranking requires an OpenRouter provider configured in Settings.',
      },
      503,
    );
  }

  const provider = getInferenceGatewayProvider(resolved.providerId);

  if (!provider?.authHeader) {
    console.error(
      formatSingleLineLog(`${LOG_PREFIX} Provider is not proxyable`, {
        providerId: resolved.providerId,
      }),
    );

    return c.json({ error: 'Brain inference provider is unavailable' }, 500);
  }

  const headers = new Headers();

  for (const [name, value] of c.req.raw.headers.entries()) {
    if (!REQUEST_HEADER_DENYLIST.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  headers.set(
    provider.authHeader.name,
    provider.authHeader.scheme === 'bearer'
      ? `Bearer ${resolved.apiKey}`
      : resolved.apiKey,
  );

  const body = await rewriteBody(await c.req.text(), resolved, upstreamPath);
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const operation = resolveOperation(upstreamPath);
  let modelId: string | null = null;

  try {
    const parsedBody = JSON.parse(body) as Record<string, unknown>;
    modelId = typeof parsedBody.model === 'string' ? parsedBody.model : null;
  } catch {
    // An unparseable body is still forwarded and accounted for without a model.
  }

  let upstream: Response;

  try {
    upstream = await fetch(
      // Carry the query string: none of today's allowed paths use one, but
      // dropping it silently is the kind of thing that only surfaces as a
      // confusing upstream error much later (Azure's ?api-version=).
      `${provider.upstreamBaseUrl}${upstreamPath}${requestUrl.search}`,
      {
        method: 'POST',
        headers,
        body,
      },
    );
  } catch (error) {
    recordBrainInferenceUsage({
      requestId,
      providerId: resolved.providerId,
      modelId,
      operation,
      upstreamPath,
      status: 502,
      startedAt,
    });
    console.warn(
      formatSingleLineLog(`${LOG_PREFIX} Upstream request failed`, {
        providerId: resolved.providerId,
        upstreamPath,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return c.json({ error: 'Brain inference upstream is unreachable' }, 502);
  }

  if (!upstream.ok) {
    console.warn(
      formatSingleLineLog(`${LOG_PREFIX} Upstream returned an error`, {
        providerId: resolved.providerId,
        upstreamPath,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
      }),
    );
  }

  recordBrainInferenceUsage({
    requestId,
    providerId: resolved.providerId,
    modelId,
    operation,
    upstreamPath,
    status: upstream.status,
    startedAt,
    response: upstream.clone(),
  });

  const responseHeaders = new Headers();

  for (const [name, value] of upstream.headers.entries()) {
    if (!RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

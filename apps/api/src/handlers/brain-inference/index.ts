import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import { Env } from '@roomote/env';

import {
  formatSingleLineLog,
  getInferenceGatewayProvider,
} from '@roomote/types';
import {
  getBrainGatewayToken,
  mapBrainModelName,
  resolveBrainInferenceProvider,
  type ResolvedBrainInference,
} from '@roomote/sdk/server';

import type { Variables } from '../../types';

const LOG_PREFIX = '[Brain Inference]';

/**
 * The Brain's whole inference surface: embeddings for recall and chat for
 * sourced synthesis and query expansion. Deliberately narrower than the
 * task-sandbox gateway's allowlist, because this credential is a static
 * deployment secret rather than a short-lived run token. Reranking is not
 * part of the Brain: retrieval is hybrid RRF, and the reranker is disabled
 * per-brain by the gbrain entrypoint.
 */
const BRAIN_ALLOWED_PATHS = new Set([
  '/v1/embeddings',
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
): Promise<string> {
  if (!rawBody) {
    return rawBody;
  }

  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;

    if (typeof parsed.model !== 'string') {
      return rawBody;
    }

    return JSON.stringify({
      ...parsed,
      model: mapBrainModelName(parsed.model, resolved),
    });
  } catch {
    // Not JSON we understand; forward untouched rather than failing the call.
    return rawBody;
  }
}

/**
 * A self-run inference upstream for one gateway path. Embeddings are the
 * Brain's bulk data path (memory text in, vectors out), so they are the one
 * a deployment may want on its own hardware; chat synthesis stays with the
 * configured model provider. Model names pass through unrewritten — the
 * upstream owns its own model registry, and every Brain is locked to its
 * embedding model at creation, so the name must mean exactly one thing
 * forever.
 */
function resolveLocalUpstream(
  upstreamPath: string,
): { baseUrl: string; apiKey?: string } | null {
  const baseUrl =
    upstreamPath === '/v1/embeddings'
      ? Env.R_BRAIN_EMBEDDINGS_UPSTREAM_URL
      : undefined;

  if (!baseUrl?.trim()) {
    return null;
  }

  return {
    baseUrl: baseUrl.trim().replace(/\/$/, ''),
    apiKey: Env.R_BRAIN_INFERENCE_UPSTREAM_API_KEY?.trim() || undefined,
  };
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

  const localUpstream = resolveLocalUpstream(upstreamPath);

  if (localUpstream) {
    const headers = new Headers();

    // Same denylist as the provider path: the gateway token in
    // `authorization` must never reach any upstream.
    for (const [name, value] of c.req.raw.headers.entries()) {
      if (!REQUEST_HEADER_DENYLIST.has(name.toLowerCase())) {
        headers.set(name, value);
      }
    }

    if (localUpstream.apiKey) {
      headers.set('authorization', `Bearer ${localUpstream.apiKey}`);
    }

    let upstream: Response;

    try {
      upstream = await fetch(
        `${localUpstream.baseUrl}${upstreamPath}${requestUrl.search}`,
        { method: 'POST', headers, body: await c.req.text() },
      );
    } catch (error) {
      console.warn(
        formatSingleLineLog(`${LOG_PREFIX} Local upstream request failed`, {
          upstreamPath,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      return c.json({ error: 'Brain inference upstream is unreachable' }, 502);
    }

    if (!upstream.ok) {
      console.warn(
        formatSingleLineLog(`${LOG_PREFIX} Local upstream returned an error`, {
          upstreamPath,
          status: upstream.status,
        }),
      );
    }

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

  const body = await rewriteBody(await c.req.text(), resolved);
  const startedAt = Date.now();

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

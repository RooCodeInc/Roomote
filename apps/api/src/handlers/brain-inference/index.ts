import { randomUUID, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import {
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES,
} from '@roomote/cloud-agents/server/non-task-provider-usage';
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
 * Sentinel chat-model id the Brain requests in gateway mode. It is not a real
 * provider model: the gateway answers it itself through the deployment's
 * helper ("small") model, which is what lets a Brain synthesize without any
 * Brain-specific provider key. An operator's `R_BRAIN_MODEL` still wins — the
 * sentinel is only the default the gbrain entrypoint configures.
 */
export const BRAIN_HELPER_MODEL_ID = 'roomote/helper';

/** How long a helper-model synthesis call may run before failing the request. */
const HELPER_SYNTHESIS_TIMEOUT_MS = 120_000;

/**
 * gbrain caps its own synthesis output; when it does not say, stay modest —
 * the helper model is a summarizer, not a long-form writer.
 */
const HELPER_SYNTHESIS_DEFAULT_MAX_OUTPUT_TOKENS = 2048;

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
 * Flatten OpenAI-style message content to plain text. Array content keeps its
 * text parts (joined) and drops the rest; the helper path is text-only.
 */
function messageContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        const record =
          part && typeof part === 'object'
            ? (part as Record<string, unknown>)
            : undefined;

        return typeof record?.text === 'string' ? [record.text] : [];
      })
      .join('\n');
  }

  return '';
}

/**
 * Convert an OpenAI chat request into the system/prompt pair
 * generateTrackedNonTaskText speaks. System messages concatenate into the
 * system string; everything else concatenates in order into the prompt, with
 * non-user roles labeled so multi-turn context stays attributable.
 */
function toHelperPromptParts(messages: unknown): {
  system: string;
  prompt: string;
} {
  const systemParts: string[] = [];
  const promptParts: string[] = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const record =
      message && typeof message === 'object'
        ? (message as Record<string, unknown>)
        : undefined;
    const role = typeof record?.role === 'string' ? record.role : 'user';
    const text = messageContentText(record?.content);

    if (!text.trim()) {
      continue;
    }

    if (role === 'system') {
      systemParts.push(text);
    } else if (role === 'user') {
      promptParts.push(text);
    } else {
      promptParts.push(
        `${role.charAt(0).toUpperCase()}${role.slice(1)}: ${text}`,
      );
    }
  }

  return {
    system: systemParts.join('\n\n'),
    prompt: promptParts.join('\n\n'),
  };
}

/**
 * gbrain relies on `response_format` for its structured synthesis calls, but
 * the helper path runs through a plain-text prompt; translate the contract
 * into a strict instruction instead of dropping it silently.
 */
function jsonResponseInstruction(responseFormat: unknown): string | null {
  const record =
    responseFormat && typeof responseFormat === 'object'
      ? (responseFormat as Record<string, unknown>)
      : undefined;

  if (record?.type === 'json_object') {
    return 'Respond with only valid JSON. No prose, no code fences.';
  }

  if (record?.type === 'json_schema') {
    return `Respond with only valid JSON that conforms to this JSON Schema. No prose, no code fences.\n${JSON.stringify(record.json_schema ?? {})}`;
  }

  return null;
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

  // The helper-model sentinel is answered here, before provider resolution,
  // because it exists precisely for deployments with no Brain provider key:
  // synthesis rides the deployment's helper model instead. An operator's
  // R_BRAIN_MODEL still wins — the sentinel is rewritten to it and forwarded
  // through the ordinary provider path below.
  let helperOverrideBody: string | undefined;

  if (upstreamPath === '/v1/chat/completions') {
    let parsedBody: Record<string, unknown> | undefined;

    try {
      const candidate = JSON.parse(await c.req.text()) as unknown;

      parsedBody =
        candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          ? (candidate as Record<string, unknown>)
          : undefined;
    } catch {
      // Not JSON we understand; the provider path forwards it untouched.
    }

    const answerWithHelperModel = async (body: Record<string, unknown>) => {
      if (body.stream === true) {
        // gbrain's gateway chat is non-streaming by design; refuse rather
        // than pretend an SSE stream that would never come.
        return c.json(
          {
            error:
              'The Brain helper model does not support streaming. Retry without stream.',
          },
          400,
        );
      }

      const { system, prompt } = toHelperPromptParts(body.messages);
      const jsonInstruction = jsonResponseInstruction(body.response_format);
      const systemWithFormat = [system, jsonInstruction]
        .filter((part): part is string => Boolean(part))
        .join('\n\n');

      try {
        const text = await generateTrackedNonTaskText({
          surface: NON_TASK_INFERENCE_SURFACES.brainSynthesis,
          modelRole: 'small',
          system: systemWithFormat || undefined,
          prompt,
          maxOutputTokens:
            typeof body.max_tokens === 'number' &&
            Number.isFinite(body.max_tokens) &&
            body.max_tokens > 0
              ? body.max_tokens
              : HELPER_SYNTHESIS_DEFAULT_MAX_OUTPUT_TOKENS,
          timeoutMs: HELPER_SYNTHESIS_TIMEOUT_MS,
        });

        return c.json({
          id: `brain-helper-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: BRAIN_HELPER_MODEL_ID,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: text },
              finish_reason: 'stop',
            },
          ],
          // Advisory only: gbrain logs usage but never bills from it, and
          // the real usage is already recorded by the tracked call above.
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (error) {
        const detail = (
          error instanceof Error ? error.message : String(error)
        ).replace(/\s+/g, ' ');

        console.warn(
          formatSingleLineLog(`${LOG_PREFIX} Helper synthesis failed`, {
            error: detail,
          }),
        );

        return c.json(
          { error: `Brain helper-model synthesis failed: ${detail}` },
          502,
        );
      }
    };

    if (parsedBody?.model === BRAIN_HELPER_MODEL_ID) {
      const overrideModel = Env.R_BRAIN_MODEL?.trim();

      if (overrideModel) {
        helperOverrideBody = JSON.stringify({
          ...parsedBody,
          model: overrideModel,
        });
      } else {
        return answerWithHelperModel(parsedBody);
      }
    } else if (parsedBody && !(await resolveBrainInferenceProvider())) {
      // No Brain provider key configured. gbrain's expansion and chat send
      // concrete model ids, not the sentinel, so without this they would
      // 503 on the provider path below — instead every chat request rides
      // the deployment's helper model, exactly like the sentinel. A
      // Brain-specific key, when configured, still takes this path's place
      // so an operator can bill Memory inference separately.
      return answerWithHelperModel(parsedBody);
    }
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

  const body = await rewriteBody(
    helperOverrideBody ?? (await c.req.text()),
    resolved,
  );
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

import type { Context } from 'hono';
import {
  formatSingleLineLog,
  getInferenceGatewayProvider,
} from '@roomote/types';
import { resolveBrainInferenceProvider } from '@roomote/sdk/server';

import type { Variables } from '../../types';
import { LOG_PREFIX, RESPONSE_HEADER_DENYLIST } from './constants';
import { copyAllowedHeaders } from './copy-headers';
import { providerHeaders } from './provider-headers';
import { rewriteBody } from './rewrite-body';

type GatewayContext = Context<{ Variables: Variables }>;

export async function forwardProviderInference(
  c: GatewayContext,
  upstreamPath: string,
  requestUrl: URL,
  helperOverrideBody: string | undefined,
): Promise<Response> {
  const resolved = await resolveBrainInferenceProvider();

  if (!resolved) {
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

  const headers = providerHeaders(c.req.raw.headers, resolved, {
    authHeader: provider.authHeader,
  });
  const body = await rewriteBody(
    helperOverrideBody ?? (await c.req.text()),
    resolved,
  );
  const startedAt = Date.now();

  let upstream: Response;

  try {
    upstream = await fetch(
      `${provider.upstreamBaseUrl}${upstreamPath}${requestUrl.search}`,
      { method: 'POST', headers, body },
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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyAllowedHeaders(upstream.headers, RESPONSE_HEADER_DENYLIST),
  });
}

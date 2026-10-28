import type { Context } from 'hono';
import { formatSingleLineLog } from '@roomote/types';
import { resolveBrainEmbeddingsUpstream } from '@roomote/sdk/server';

import type { Variables } from '../../types';
import {
  LOG_PREFIX,
  REQUEST_HEADER_DENYLIST,
  RESPONSE_HEADER_DENYLIST,
} from './constants';
import { copyAllowedHeaders } from './copy-headers';

type GatewayContext = Context<{ Variables: Variables }>;

function embeddingModelFromBody(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);

    if (
      parsed &&
      typeof parsed === 'object' &&
      'model' in parsed &&
      typeof parsed.model === 'string'
    ) {
      return parsed.model.trim() || undefined;
    }
  } catch {
    // Forward the body unchanged; a missing model only affects routing.
  }

  return undefined;
}

export async function forwardLocalEmbeddings(
  c: GatewayContext,
  upstreamPath: string,
  requestUrl: URL,
): Promise<Response | null> {
  if (upstreamPath !== '/v1/embeddings') {
    return null;
  }

  const body = await c.req.text();
  const localUpstream = await resolveBrainEmbeddingsUpstream(
    embeddingModelFromBody(body),
  );

  if (!localUpstream) {
    return null;
  }

  const headers = copyAllowedHeaders(
    c.req.raw.headers,
    REQUEST_HEADER_DENYLIST,
  );

  if (localUpstream.apiKey) {
    headers.set('authorization', `Bearer ${localUpstream.apiKey}`);
  }

  let upstream: Response;

  try {
    upstream = await fetch(
      `${localUpstream.baseUrl}${upstreamPath}${requestUrl.search}`,
      { method: 'POST', headers, body },
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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyAllowedHeaders(upstream.headers, RESPONSE_HEADER_DENYLIST),
  });
}

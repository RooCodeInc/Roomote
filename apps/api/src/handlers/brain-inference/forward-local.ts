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

export async function forwardLocalEmbeddings(
  c: GatewayContext,
  upstreamPath: string,
  requestUrl: URL,
): Promise<Response | null> {
  if (upstreamPath !== '/v1/embeddings') {
    return null;
  }

  const localUpstream = await resolveBrainEmbeddingsUpstream();

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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyAllowedHeaders(upstream.headers, RESPONSE_HEADER_DENYLIST),
  });
}

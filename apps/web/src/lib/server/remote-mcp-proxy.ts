import { NextRequest, NextResponse } from 'next/server';

import {
  getRoomoteMcpProtectedResourceMetadataUrl,
  getRoomoteMcpResourceUrl,
} from '@roomote/auth';

import { bootstrapWebRuntimeEnv } from './bootstrap-runtime-env';

const HOP_BY_HOP_HEADERS = [
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function removeHopByHopHeaders(headers: Headers): Headers {
  const nextHeaders = new Headers(headers);
  for (const header of HOP_BY_HOP_HEADERS) nextHeaders.delete(header);
  return nextHeaders;
}

function sanitizeRequestHeaders(headers: Headers): Headers {
  const nextHeaders = removeHopByHopHeaders(headers);
  nextHeaders.delete('host');
  nextHeaders.delete('forwarded');
  for (const header of [...nextHeaders.keys()]) {
    if (header.startsWith('x-forwarded-')) nextHeaders.delete(header);
  }
  return nextHeaders;
}

export function sanitizeProxiedResponseHeaders(headers: Headers): Headers {
  const nextHeaders = removeHopByHopHeaders(headers);

  // fetch() transparently decompresses upstream responses while retaining the
  // original content-encoding header. Forwarding that stale header makes the
  // client try to decompress an already-decoded response body.
  nextHeaders.delete('content-encoding');

  return nextHeaders;
}

export async function proxyRemoteMcpRequest(
  request: NextRequest,
  endpoint: 'mcp' | 'metadata',
) {
  const env = await bootstrapWebRuntimeEnv();
  const targetUrl =
    endpoint === 'mcp'
      ? new URL(getRoomoteMcpResourceUrl(env.TRPC_URL))
      : new URL(getRoomoteMcpProtectedResourceMetadataUrl(env.TRPC_URL));
  targetUrl.search = request.nextUrl.search;

  const publicUrl = new URL(env.R_PUBLIC_URL ?? env.R_APP_URL);
  const headers = sanitizeRequestHeaders(request.headers);
  headers.set('x-forwarded-host', publicUrl.host);
  headers.set('x-forwarded-proto', publicUrl.protocol.replace(':', ''));

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body:
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer(),
    redirect: 'manual',
  });

  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizeProxiedResponseHeaders(response.headers),
  });
}

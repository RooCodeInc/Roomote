import { NextRequest, NextResponse } from 'next/server';

import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOP_BY_HOP_HEADERS = [
  'connection',
  'content-length',
  // Azure DevOps service hooks send `Expect: 100-continue`; undici's fetch
  // rejects the header outright (UND_ERR_NOT_SUPPORTED), and the 100-continue
  // handshake is meaningless to replay on a proxied request.
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

type RouteContext = {
  params: Promise<{ path?: string[] }> | { path?: string[] };
};

function removeHopByHopHeaders(headers: Headers): Headers {
  const nextHeaders = new Headers(headers);

  for (const header of HOP_BY_HOP_HEADERS) {
    nextHeaders.delete(header);
  }

  return nextHeaders;
}

function resolveApiUrl(baseUrl: string, path: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.replace(/^\/+/, '');

  return new URL(normalizedPath, normalizedBaseUrl);
}

async function resolvePath(context: RouteContext): Promise<string> {
  const params = await context.params;
  const path = params.path ?? [];

  return path.map((segment) => encodeURIComponent(segment)).join('/');
}

async function forwardWebhookRequest(
  request: NextRequest,
  context: RouteContext,
) {
  const env = await bootstrapWebRuntimeEnv();
  const path = await resolvePath(context);
  const targetUrl = resolveApiUrl(env.R_TRPC_URL, `/api/webhooks/${path}`);
  targetUrl.search = request.nextUrl.search;

  const headers = removeHopByHopHeaders(request.headers);
  const host = request.headers.get('host');

  if (host) {
    headers.set('x-forwarded-host', host);
  }

  headers.set('x-forwarded-proto', request.nextUrl.protocol.replace(':', ''));

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
    headers: removeHopByHopHeaders(response.headers),
  });
}

export const DELETE = forwardWebhookRequest;
export const GET = forwardWebhookRequest;
export const PATCH = forwardWebhookRequest;
export const POST = forwardWebhookRequest;
export const PUT = forwardWebhookRequest;

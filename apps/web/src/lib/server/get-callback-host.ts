import type { NextRequest } from 'next/server';

import { Env } from './env';

// Hostnames the server may see on incoming requests that are not reachable
// from the user's browser: loopback hosts in local dev behind ngrok, and the
// wildcard listen addresses the Next.js standalone server binds to in
// containers (HOSTNAME=0.0.0.0), which it echoes back in request.url.
const INTERNAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::]',
  '[::1]',
]);

export function getCallbackHost(request: NextRequest) {
  const url = new URL(request.url);

  // Rewrite any internal origin (any scheme/port) to the configured public
  // URL so OAuth redirects land back on the host the user's browser can
  // actually reach (e.g. the ngrok or self-host public domain) instead of
  // https://localhost:13000 or http://0.0.0.0:3000.
  if (INTERNAL_HOSTNAMES.has(url.hostname)) {
    return `${Env.R_APP_URL}${url.pathname}${url.search}`;
  }

  return request.url;
}

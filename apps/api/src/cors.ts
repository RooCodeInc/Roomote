import { Env } from '@roomote/env';

/** Configured browser origins allowed to call the API with credentials. */
function buildAllowedApiOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const url of [Env.ROOMOTE_APP_URL, Env.ROOMOTE_PUBLIC_URL]) {
    if (!url) {
      continue;
    }
    try {
      origins.add(new URL(url).origin);
    } catch {
      // Ignore malformed configured URLs.
    }
  }
  return origins;
}

// `Env` is immutable after load, so resolve the allowlist once at module load
// rather than rebuilding it on every request.
const ALLOWED_API_ORIGINS = buildAllowedApiOrigins();

/**
 * Reflect the request Origin only when it is a configured app origin, so the
 * API never echoes an arbitrary origin back with `credentials: true`.
 * Development stays permissive so local cross-origin tooling keeps working.
 * Requests with no Origin header (server-to-server, same-origin) are not
 * subject to CORS and pass through unchanged.
 */
export function resolveApiCorsOrigin(origin: string): string | null {
  if (!origin) {
    return origin;
  }
  if (Env.APP_ENV === 'development') {
    return origin;
  }
  return ALLOWED_API_ORIGINS.has(origin) ? origin : null;
}

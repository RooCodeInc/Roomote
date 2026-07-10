import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

import { Env } from '@roomote/env';

const RATE_LIMIT_WINDOW_MS = 60_000;

// Cap on tracked client windows so spoofed x-forwarded-for values cannot grow
// the map without bound; when the cap is hit, expired windows are swept and,
// if every window is still live, the earliest-tracked client is evicted.
const MAX_TRACKED_CLIENT_WINDOWS = 10_000;

const UNKNOWN_CLIENT_KEY = 'unknown';

type RateLimitWindow = {
  windowStartMs: number;
  count: number;
};

function resolveClientKey(c: Parameters<MiddlewareHandler>[0]): string {
  // First hop of x-forwarded-for is the original client behind the reverse
  // proxy (self-host Caddy, hosted load balancers). The header is spoofable;
  // this limiter is abuse dampening, not a security control.
  const forwardedClientIp = c.req
    .header('x-forwarded-for')
    ?.split(',')[0]
    ?.trim();

  if (forwardedClientIp) {
    return forwardedClientIp;
  }

  try {
    const remoteAddress = getConnInfo(c).remote.address?.trim();

    if (remoteAddress) {
      return remoteAddress;
    }
  } catch {
    // getConnInfo throws outside the node-server adaptor (for example in
    // app.request-based tests); fall through to the shared key.
  }

  return UNKNOWN_CLIENT_KEY;
}

/**
 * Basic fixed-window per-client-IP rate limiter for the `/health` alias.
 *
 * Deliberately in-memory and per-process: a health check that verifies Redis
 * connectivity must not itself depend on Redis, and each replica keeping its
 * own budget is acceptable for basic abuse dampening.
 */
export function healthRateLimitMiddleware(options?: {
  maxTrackedClientWindows?: number;
}): MiddlewareHandler {
  const maxTrackedClientWindows =
    options?.maxTrackedClientWindows ?? MAX_TRACKED_CLIENT_WINDOWS;
  const windows = new Map<string, RateLimitWindow>();

  const sweepExpiredWindows = (now: number): void => {
    for (const [key, window] of windows) {
      if (now - window.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
        windows.delete(key);
      }
    }
  };

  const evictForNewClient = (now: number): void => {
    sweepExpiredWindows(now);

    if (windows.size < maxTrackedClientWindows) {
      return;
    }

    // Every tracked window is still live: evict the earliest-tracked client
    // so the map stays bounded even under a flood of unique spoofed
    // addresses. The evicted client simply restarts a fresh window later.
    const earliestTrackedKey = windows.keys().next().value;

    if (earliestTrackedKey !== undefined) {
      windows.delete(earliestTrackedKey);
    }
  };

  return async (c, next) => {
    const limitPerMinute = Env.API_HEALTH_RATE_LIMIT_PER_MINUTE;

    if (limitPerMinute <= 0) {
      await next();
      return;
    }

    const now = Date.now();
    const clientKey = resolveClientKey(c);
    const window = windows.get(clientKey);

    if (!window || now - window.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
      if (!window && windows.size >= maxTrackedClientWindows) {
        evictForNewClient(now);
      }

      windows.set(clientKey, { windowStartMs: now, count: 1 });
      await next();
      return;
    }

    window.count += 1;

    if (window.count > limitPerMinute) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((window.windowStartMs + RATE_LIMIT_WINDOW_MS - now) / 1000),
      );

      return c.json({ error: 'Too many requests' }, 429, {
        'Retry-After': String(retryAfterSeconds),
      });
    }

    await next();
  };
}

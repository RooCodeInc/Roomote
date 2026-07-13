import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

import { Env } from '@roomote/env';

import { recordRequestEndpointMetric } from '../monitoring/request-endpoint-metrics';

const EXCLUDED_REQUEST_METRICS_PATHS = new Set([
  '/',
  '/health/api',
  '/health/liveness',
  '/health/controller',
]);

const TRPC_PATH_PREFIX = '/trpc';
const UNMATCHED_ROUTE = '<unmatched>';

function isRawPathMetricsRoute(path: string): boolean {
  return path === TRPC_PATH_PREFIX || path.startsWith(`${TRPC_PATH_PREFIX}/`);
}

function resolveRequestMetricsRoute(
  c: Parameters<MiddlewareHandler>[0],
  path: string,
): string {
  if (isRawPathMetricsRoute(path)) {
    return path;
  }

  // -1 retrieves the last (innermost) matched route path from Hono's route
  // stack, which gives us the most specific template for the request (e.g.
  // "/:taskId/messages" rather than the outer wildcard "*").
  const matchedRoutePath = routePath(c, -1);

  if (
    !matchedRoutePath ||
    matchedRoutePath === '*' ||
    matchedRoutePath === '/*'
  ) {
    return UNMATCHED_ROUTE;
  }

  return matchedRoutePath;
}

export const requestObservabilityMiddleware: MiddlewareHandler = async (
  c,
  next,
) => {
  const slowRequestThresholdMs = Env.R_API_SLOW_REQUEST_THRESHOLD_MS;
  const startedAt = Date.now();
  let thrownError: unknown;

  try {
    await next();
  } catch (error) {
    thrownError = error;
    throw error;
  } finally {
    const durationMs = Date.now() - startedAt;
    const path = c.req.path;
    const status = thrownError ? 500 : c.res.status;

    if (!EXCLUDED_REQUEST_METRICS_PATHS.has(path)) {
      recordRequestEndpointMetric({
        method: c.req.method,
        route: resolveRequestMetricsRoute(c, path),
        status,
        durationMs,
      });
    }

    if (durationMs >= slowRequestThresholdMs) {
      const requestId = c.req.header('x-request-id');
      const requestIdSuffix = requestId ? ` requestId=${requestId}` : '';

      console.warn(
        `[API Slow Request] ${c.req.method} ${path} status=${status} durationMs=${durationMs}${requestIdSuffix}`,
      );
    }
  }
};

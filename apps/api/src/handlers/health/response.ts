import type { Context } from 'hono';

import type { Variables } from '../../types';

type HealthResponseBase = {
  server: string;
  ok: boolean;
  timestamp: string;
  /**
   * Names of the sub-checks that failed (e.g. "stuckAfterDequeue"). Part of
   * the unauthenticated base so an unhealthy response is diagnosable without
   * reading server logs; detailed errors stay behind authentication.
   */
  failingChecks?: string[];
};

function hasAuthenticatedHealthDiagnostics(
  c: Context<{ Variables: Variables }>,
): boolean {
  return c.get('authContext') !== undefined;
}

export function buildHealthResponse<T extends Record<string, unknown>>(
  c: Context<{ Variables: Variables }>,
  base: HealthResponseBase,
  detailed: T,
): HealthResponseBase | (HealthResponseBase & T) {
  if (!hasAuthenticatedHealthDiagnostics(c)) {
    return base;
  }

  return {
    ...base,
    ...detailed,
  };
}

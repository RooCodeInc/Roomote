import type { Context } from 'hono';

import type { Variables } from '../../types';

type HealthResponseBase = {
  server: string;
  ok: boolean;
  timestamp: string;
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

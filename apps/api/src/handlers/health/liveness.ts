import { Hono } from 'hono';

import { Env } from '@roomote/env';
import type { Variables } from '../../types';
import { buildHealthResponse } from './response';

export const apiLiveness = new Hono<{ Variables: Variables }>();

/**
 * Process-local liveness check used by runtime supervisors and container
 * health checks.
 *
 * This intentionally does NOT touch Postgres or Redis. A shared-dependency
 * slowdown (e.g. database latency) must not fail process liveness checks:
 * pulling every API process out of rotation turns a slow database into a total
 * API outage. Deep dependency checks live at `/` and `/health/controller`.
 */
apiLiveness.get('/', (c) =>
  c.json(
    buildHealthResponse(
      c,
      {
        server: 'api',
        ok: true,
        timestamp: new Date().toISOString(),
      },
      {
        environment: { NODE_ENV: Env.NODE_ENV, APP_ENV: Env.APP_ENV },
      },
    ),
  ),
);

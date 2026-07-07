import { Hono } from 'hono';

import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';
import { db } from '@roomote/db/server';

import type { Variables } from '../../types';
import { getLongLivedProxyStreamHealthSnapshot } from '../long-lived-proxy-stream-registry';
import { getRequestEndpointMetricsSnapshot } from '../../monitoring/request-endpoint-metrics';
import {
  getHealthCheckErrorMessage,
  getHealthCheckResponseErrorMessage,
  logHealthCheckDiagnostics,
  runTimedHealthCheck,
  toHealthCheckLogEntry,
} from './diagnostics';
import { buildHealthResponse } from './response';

export const apiHealth = new Hono<{ Variables: Variables }>();

apiHealth.get('/', async (c) => {
  const requestStartedAt = Date.now();
  const slowThresholdMs = Env.API_SLOW_REQUEST_THRESHOLD_MS;

  const dbCheck = await runTimedHealthCheck('db', async () => {
    try {
      await db.execute('SELECT 1');
      return {
        ok: true,
        error: undefined as string | undefined,
        responseError: undefined as string | undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: getHealthCheckErrorMessage(error),
        responseError: getHealthCheckResponseErrorMessage(error),
      };
    }
  });

  if (!dbCheck.value.ok) {
    logHealthCheckDiagnostics({
      route: c.req.path,
      totalDurationMs: Date.now() - requestStartedAt,
      slowThresholdMs,
      checks: [
        toHealthCheckLogEntry({
          check: dbCheck,
          ok: dbCheck.value.ok,
          error: dbCheck.value.error,
        }),
      ],
    });

    return c.json(
      buildHealthResponse(
        c,
        {
          server: 'api',
          ok: false,
          timestamp: new Date().toISOString(),
        },
        {
          environment: { NODE_ENV: Env.NODE_ENV, APP_ENV: Env.APP_ENV },
          monitoring: {
            longLivedProxyStreams: getLongLivedProxyStreamHealthSnapshot(),
            requestEndpointMetrics: getRequestEndpointMetricsSnapshot(),
          },
          error: dbCheck.value.responseError,
        },
      ),
      { status: 503 },
    );
  }

  const redisCheck = await runTimedHealthCheck('redis', async () => {
    try {
      await getRedis().ping();
      return {
        ok: true,
        error: undefined as string | undefined,
        responseError: undefined as string | undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: getHealthCheckErrorMessage(error),
        responseError: getHealthCheckResponseErrorMessage(error),
      };
    }
  });

  const ok = dbCheck.value.ok && redisCheck.value.ok;
  const error = dbCheck.value.responseError ?? redisCheck.value.responseError;

  logHealthCheckDiagnostics({
    route: c.req.path,
    totalDurationMs: Date.now() - requestStartedAt,
    slowThresholdMs,
    checks: [
      toHealthCheckLogEntry({
        check: dbCheck,
        ok: dbCheck.value.ok,
        error: dbCheck.value.error,
      }),
      toHealthCheckLogEntry({
        check: redisCheck,
        ok: redisCheck.value.ok,
        error: redisCheck.value.error,
      }),
    ],
  });

  return c.json(
    buildHealthResponse(
      c,
      {
        server: 'api',
        ok,
        timestamp: new Date().toISOString(),
      },
      {
        environment: { NODE_ENV: Env.NODE_ENV, APP_ENV: Env.APP_ENV },
        monitoring: {
          longLivedProxyStreams: getLongLivedProxyStreamHealthSnapshot(),
          requestEndpointMetrics: getRequestEndpointMetricsSnapshot(),
        },
        error,
      },
    ),
    { status: ok ? 200 : 503 },
  );
});

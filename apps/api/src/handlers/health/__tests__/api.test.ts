import { Hono } from 'hono';
import type { Variables } from '../../../types';

const envMock = vi.hoisted(() => ({
  NODE_ENV: 'test' as 'test' | 'development' | 'production',
  APP_ENV: 'development' as
    | 'development'
    | 'preview'
    | 'production'
    | undefined,
  API_SLOW_REQUEST_THRESHOLD_MS: 3_000,
}));

const dbExecuteMock = vi.hoisted(() => vi.fn());
const redisPingMock = vi.hoisted(() => vi.fn());

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: envMock,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    execute: dbExecuteMock,
  },
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    ping: redisPingMock,
  }),
}));

import { apiHealth } from '../api';
import {
  registerLongLivedProxyStream,
  resetLongLivedProxyStreamRegistryForTests,
} from '../../long-lived-proxy-stream-registry';
import {
  recordRequestEndpointMetric,
  resetRequestEndpointMetricsForTests,
} from '../../../monitoring/request-endpoint-metrics';

const authContext = {
  tokenType: 'auth',
  userId: 'user-123',
} as Variables['authContext'];

function createApp(authOverride?: Variables['authContext']) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (authOverride) {
      c.set('authContext', authOverride);
    }

    await next();
  });
  app.route('/health/api', apiHealth);
  return app;
}

describe('apiHealth', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T06:00:00.000Z'));
    vi.clearAllMocks();
    resetLongLivedProxyStreamRegistryForTests();
    resetRequestEndpointMetricsForTests();
    dbExecuteMock.mockResolvedValue(undefined);
    redisPingMock.mockResolvedValue('PONG');
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetLongLivedProxyStreamRegistryForTests();
    resetRequestEndpointMetricsForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports long-lived proxy stream monitoring in the health payload', async () => {
    registerLongLivedProxyStream({
      route: 'mcp:Docs',
      method: 'POST',
      path: '/mcp',
      requestId: 'req-docs',
    });

    vi.advanceTimersByTime(5 * 60_000);

    registerLongLivedProxyStream({
      route: 'mcp:GitHub',
      method: 'GET',
      path: '/mcp',
      requestId: 'req-mcp',
    });

    vi.advanceTimersByTime(30_000);

    const response = await createApp(authContext).request('/health/api');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      server: 'api',
      environment: {
        NODE_ENV: 'test',
        APP_ENV: 'development',
      },
      monitoring: {
        longLivedProxyStreams: {
          activeCount: 2,
          oldestAgeMs: 330_000,
          countsByAge: {
            atLeast1m: 1,
            atLeast5m: 1,
            atLeast15m: 0,
          },
          byRoute: {
            'mcp:Docs': 1,
            'mcp:GitHub': 1,
          },
          warningActive: false,
          warningThresholds: {
            activeCount: 20,
            oldestAgeMs: 600_000,
          },
        },
        requestEndpointMetrics: {
          sinceStartedAt: '2026-03-21T06:00:00.000Z',
          totalRequests: 0,
          trackedEndpointCount: 0,
          overflowedUniqueEndpointCount: 0,
          overflowedRequestCount: 0,
          endpoints: [],
        },
      },
      ok: true,
      error: undefined,
      timestamp: '2026-03-21T06:05:30.000Z',
    });
  });

  it('reports request endpoint metrics sorted by count and average duration', async () => {
    recordRequestEndpointMetric({
      method: 'GET',
      route: '/trpc/tasks.list',
      status: 200,
      durationMs: 30,
    });
    recordRequestEndpointMetric({
      method: 'GET',
      route: '/api/tasks/:taskId/messages',
      status: 200,
      durationMs: 40,
    });

    vi.advanceTimersByTime(10_000);

    recordRequestEndpointMetric({
      method: 'GET',
      route: '/api/tasks/:taskId/messages',
      status: 500,
      durationMs: 80,
    });
    recordRequestEndpointMetric({
      method: 'GET',
      route: '/trpc/tasks.list',
      status: 404,
      durationMs: 10,
    });

    const response = await createApp(authContext).request('/health/api');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      server: 'api',
      environment: {
        NODE_ENV: 'test',
        APP_ENV: 'development',
      },
      monitoring: {
        longLivedProxyStreams: {
          activeCount: 0,
          oldestAgeMs: null,
          countsByAge: {
            atLeast1m: 0,
            atLeast5m: 0,
            atLeast15m: 0,
          },
          byRoute: {},
          warningActive: false,
          warningThresholds: {
            activeCount: 20,
            oldestAgeMs: 600_000,
          },
        },
        requestEndpointMetrics: {
          sinceStartedAt: '2026-03-21T06:00:00.000Z',
          totalRequests: 4,
          trackedEndpointCount: 2,
          overflowedUniqueEndpointCount: 0,
          overflowedRequestCount: 0,
          endpoints: [
            {
              method: 'GET',
              route: '/api/tasks/:taskId/messages',
              count: 2,
              statusCounts: {
                '2xx': 1,
                '3xx': 0,
                '4xx': 0,
                '5xx': 1,
                other: 0,
              },
              avgDurationMs: 60,
              maxDurationMs: 80,
              lastDurationMs: 80,
              lastSeenAt: '2026-03-21T06:00:10.000Z',
            },
            {
              method: 'GET',
              route: '/trpc/tasks.list',
              count: 2,
              statusCounts: {
                '2xx': 1,
                '3xx': 0,
                '4xx': 1,
                '5xx': 0,
                other: 0,
              },
              avgDurationMs: 20,
              maxDurationMs: 30,
              lastDurationMs: 10,
              lastSeenAt: '2026-03-21T06:00:10.000Z',
            },
          ],
        },
      },
      ok: true,
      error: undefined,
      timestamp: '2026-03-21T06:00:10.000Z',
    });
  });

  it('returns a redacted unhealthy response to unauthenticated callers', async () => {
    dbExecuteMock.mockRejectedValue(new Error('database unavailable'));

    const response = await createApp().request('/health/api');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      server: 'api',
      ok: false,
      timestamp: '2026-03-21T06:00:00.000Z',
    });
  });

  it('returns detailed diagnostics to authenticated callers', async () => {
    registerLongLivedProxyStream({
      route: 'mcp:Docs',
      method: 'POST',
      path: '/mcp',
      requestId: 'req-docs',
    });

    const response = await createApp(authContext).request('/health/api');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        environment: {
          NODE_ENV: 'test',
          APP_ENV: 'development',
        },
        monitoring: expect.objectContaining({
          longLivedProxyStreams: expect.objectContaining({
            activeCount: 1,
          }),
        }),
      }),
    );
  });

  it('logs per-check timings when the health request is slow', async () => {
    dbExecuteMock.mockImplementation(async () => {
      vi.advanceTimersByTime(3_500);
    });

    const response = await createApp(authContext).request('/health/api');

    expect(response.status).toBe(200);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

    const [message] = consoleWarnSpy.mock.calls[0] ?? [];
    expect(message).toContain('[Health Check]');
    expect(message).toContain('"route":"/health/api"');
    expect(message).toContain('"status":"slow"');
    expect(message).toContain('"name":"db"');
    expect(message).toContain('"durationMs":3500');
    expect(message).toContain('"name":"redis"');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs per-check failure details when the health request is unhealthy', async () => {
    dbExecuteMock.mockRejectedValue(new Error('database unavailable'));

    const response = await createApp(authContext).request('/health/api');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'database unavailable',
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(redisPingMock).not.toHaveBeenCalled();

    const [message] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(message).toContain('[Health Check]');
    expect(message).toContain('"route":"/health/api"');
    expect(message).toContain('"status":"unhealthy"');
    expect(message).toContain('"name":"db"');
    expect(message).toContain('Error: database unavailable');
    expect(message).not.toContain('"name":"redis"');
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});

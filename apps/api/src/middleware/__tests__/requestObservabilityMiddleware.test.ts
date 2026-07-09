import { Hono } from 'hono';
import { Env } from '@roomote/env';

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      API_SLOW_REQUEST_THRESHOLD_MS: 5_000,
    },
  };
});

import {
  getRequestEndpointMetricsSnapshot,
  resetRequestEndpointMetricsForTests,
} from '../../monitoring/request-endpoint-metrics';
import { requestObservabilityMiddleware } from '../requestObservabilityMiddleware';

function createApp() {
  const app = new Hono();
  const tasksRouter = new Hono();
  const trpcRouter = new Hono();

  app.use('*', requestObservabilityMiddleware);

  tasksRouter.get('/:taskId/messages', (c) => c.json({ ok: true }));
  trpcRouter.all('/', (c) => c.json({ ok: true }));
  trpcRouter.all('/*', (c) => c.json({ ok: true }));

  app.route('/api/tasks', tasksRouter);
  app.route('/trpc', trpcRouter);

  app.get('/', (c) => c.text('ok'));
  app.get('/health/api', (c) => c.text('ok'));
  app.get('/health/liveness', (c) => c.text('ok'));
  app.get('/health/controller', (c) => c.text('ok'));
  app.get('/error', () => {
    throw new Error('boom');
  });

  return app;
}

describe('requestObservabilityMiddleware', () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetRequestEndpointMetricsForTests();
  });

  afterEach(() => {
    resetRequestEndpointMetricsForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs requests that exceed the slow-request threshold', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 100;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const app = new Hono();

    app.use('*', requestObservabilityMiddleware);
    app.get('/slow', (c) => {
      now += Env.API_SLOW_REQUEST_THRESHOLD_MS;
      return c.text('ok');
    });

    await app.request('http://localhost/slow', {
      headers: {
        'x-request-id': 'req_123',
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      `[API Slow Request] GET /slow status=200 durationMs=${Env.API_SLOW_REQUEST_THRESHOLD_MS} requestId=req_123`,
    );

    dateNowSpy.mockRestore();
  });

  it('does not log fast requests', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp();

    await app.request('http://localhost/api/tasks/123/messages');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('collapses dynamic REST routes to the matched route template', async () => {
    const app = createApp();

    await app.request('http://localhost/api/tasks/123/messages');
    await app.request('http://localhost/api/tasks/456/messages');

    expect(getRequestEndpointMetricsSnapshot().endpoints).toEqual([
      expect.objectContaining({
        method: 'GET',
        route: '/api/tasks/:taskId/messages',
        count: 2,
      }),
    ]);
  });

  it('keeps tRPC procedures distinct by raw pathname', async () => {
    const app = createApp();

    await app.request('http://localhost/trpc/cloudJobs.recordLog');
    await app.request(
      'http://localhost/trpc/mcpConnections.getMcpServerConfigs',
    );

    expect(
      getRequestEndpointMetricsSnapshot()
        .endpoints.map((endpoint) => endpoint.route)
        .sort(),
    ).toEqual([
      '/trpc/cloudJobs.recordLog',
      '/trpc/mcpConnections.getMcpServerConfigs',
    ]);
  });

  it('excludes health endpoints from the metrics snapshot', async () => {
    const app = createApp();

    await app.request('http://localhost/');
    await app.request('http://localhost/health');
    await app.request('http://localhost/health/api');
    await app.request('http://localhost/health/liveness');
    await app.request('http://localhost/health/controller');

    expect(getRequestEndpointMetricsSnapshot()).toEqual({
      sinceStartedAt: expect.any(String),
      totalRequests: 0,
      trackedEndpointCount: 0,
      overflowedUniqueEndpointCount: 0,
      overflowedRequestCount: 0,
      endpoints: [],
    });
  });

  it('records thrown handler errors as 500s', async () => {
    const app = createApp();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await app.request('http://localhost/error');

    expect(response.status).toBe(500);
    expect(getRequestEndpointMetricsSnapshot().endpoints).toEqual([
      expect.objectContaining({
        method: 'GET',
        route: '/error',
        count: 1,
        statusCounts: {
          '2xx': 0,
          '3xx': 0,
          '4xx': 0,
          '5xx': 1,
          other: 0,
        },
      }),
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

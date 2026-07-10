vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      ...actual.Env,
      API_SLOW_REQUEST_THRESHOLD_MS: 0,
      API_HEALTH_RATE_LIMIT_PER_MINUTE: 2,
    },
  };
});

import type { RunningApiServer } from './server-harness';

import {
  getRequestEndpointMetricsSnapshot,
  resetRequestEndpointMetricsForTests,
} from '../monitoring/request-endpoint-metrics';
import { startTestApiServer } from './server-harness';

describe('api live server integration', () => {
  let api: RunningApiServer | undefined;

  function requireApi(): RunningApiServer {
    if (!api) {
      throw new Error('Expected test API server to be running');
    }

    return api;
  }

  beforeAll(async () => {
    api = await startTestApiServer();
  }, 20_000);

  afterAll(async () => {
    if (api) {
      await api.close();
    }
  });

  beforeEach(() => {
    resetRequestEndpointMetricsForTests();
  });

  afterEach(() => {
    resetRequestEndpointMetricsForTests();
    vi.restoreAllMocks();
  });

  it('serves the /health alias with a public payload and rate limits only that path', async () => {
    const baseUrl = requireApi().baseUrl;

    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${baseUrl}/health`);

      expect([200, 503]).toContain(response.status);

      const payload = (await response.json()) as Record<string, unknown>;

      // Unauthenticated callers get only the redacted public fields.
      expect(Object.keys(payload).sort()).toEqual([
        'ok',
        'server',
        'timestamp',
      ]);
      expect(payload.server).toBe('api');
    }

    const limited = await fetch(`${baseUrl}/health`);

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    await expect(limited.json()).resolves.toEqual({
      error: 'Too many requests',
    });

    const unlimitedSibling = await fetch(`${baseUrl}/health/liveness`);

    expect(unlimitedSibling.status).toBe(200);
  });

  it('rejects unauthenticated cloud job log requests over HTTP', async () => {
    const response = await fetch(
      `${requireApi().baseUrl}/api/cloud-jobs/123/logs`,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized request',
    });
  });

  it('logs slow requests through the real HTTP listener', async () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const response = await fetch(
      `${requireApi().baseUrl}/api/cloud-jobs/123/logs`,
      {
        headers: {
          'x-request-id': 'req-live-server-123',
        },
      },
    );

    expect(response.status).toBe(401);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[API Slow Request] GET /api/cloud-jobs/123/logs status=401 durationMs=',
      ),
    );
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain(
      'requestId=req-live-server-123',
    );
  });

  it('records request endpoint metrics through the real HTTP listener', async () => {
    const response = await fetch(
      `${requireApi().baseUrl}/api/cloud-jobs/123/logs`,
    );

    expect(response.status).toBe(401);
    expect(getRequestEndpointMetricsSnapshot()).toEqual({
      sinceStartedAt: expect.any(String),
      totalRequests: 1,
      trackedEndpointCount: 1,
      overflowedUniqueEndpointCount: 0,
      overflowedRequestCount: 0,
      endpoints: [
        expect.objectContaining({
          method: 'GET',
          route: '/api/cloud-jobs/:id/logs',
          count: 1,
          statusCounts: {
            '2xx': 0,
            '3xx': 0,
            '4xx': 1,
            '5xx': 0,
            other: 0,
          },
        }),
      ],
    });
  });

  it('uses HOST when no explicit hostname is provided', async () => {
    const originalHost = process.env.HOST;
    let hostBoundApi: RunningApiServer | undefined;

    try {
      process.env.HOST = '127.0.0.1';
      hostBoundApi = await startTestApiServer({ hostname: undefined });

      const response = await fetch(`${hostBoundApi.baseUrl}/health/liveness`);

      expect(response.status).toBe(200);
    } finally {
      if (hostBoundApi) {
        await hostBoundApi.close();
      }

      if (originalHost === undefined) {
        delete process.env.HOST;
      } else {
        process.env.HOST = originalHost;
      }
    }
  });
});

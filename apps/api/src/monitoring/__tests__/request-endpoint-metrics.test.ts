import {
  getRequestEndpointMetricsSnapshot,
  recordRequestEndpointMetric,
  resetRequestEndpointMetricsForTests,
} from '../request-endpoint-metrics';

describe('request endpoint metrics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T06:00:00.000Z'));
    vi.clearAllMocks();
    resetRequestEndpointMetricsForTests();
  });

  afterEach(() => {
    resetRequestEndpointMetricsForTests();
    vi.useRealTimers();
  });

  it('tracks counts, status buckets, averages, and last-seen timestamps', () => {
    recordRequestEndpointMetric({
      method: 'GET',
      route: '/api/tasks/:taskId/messages',
      status: 200,
      durationMs: 100,
    });

    vi.advanceTimersByTime(10_000);

    recordRequestEndpointMetric({
      method: 'GET',
      route: '/api/tasks/:taskId/messages',
      status: 404,
      durationMs: 300,
    });

    expect(getRequestEndpointMetricsSnapshot()).toEqual({
      sinceStartedAt: '2026-03-21T06:00:00.000Z',
      totalRequests: 2,
      trackedEndpointCount: 1,
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
            '4xx': 1,
            '5xx': 0,
            other: 0,
          },
          avgDurationMs: 200,
          maxDurationMs: 300,
          lastDurationMs: 300,
          lastSeenAt: '2026-03-21T06:00:10.000Z',
        },
      ],
    });
  });

  it('caps tracked endpoints and warns when overflowed routes accumulate', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let index = 0; index < 256; index++) {
      recordRequestEndpointMetric({
        method: 'GET',
        route: `/endpoint-${index}`,
        status: 200,
        durationMs: index,
      });
    }

    recordRequestEndpointMetric({
      method: 'GET',
      route: '/overflow-a',
      status: 200,
      durationMs: 5,
    });
    recordRequestEndpointMetric({
      method: 'GET',
      route: '/overflow-a',
      status: 500,
      durationMs: 15,
    });
    recordRequestEndpointMetric({
      method: 'POST',
      route: '/overflow-b',
      status: 200,
      durationMs: 10,
    });
    recordRequestEndpointMetric({
      method: 'GET',
      route: '/endpoint-0',
      status: 200,
      durationMs: 25,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);

    const snapshot = getRequestEndpointMetricsSnapshot();

    expect(snapshot.totalRequests).toBe(260);
    expect(snapshot.trackedEndpointCount).toBe(256);
    expect(snapshot.overflowedUniqueEndpointCount).toBe(2);
    expect(snapshot.overflowedRequestCount).toBe(3);
    expect(
      snapshot.endpoints.find(
        (endpoint) =>
          endpoint.method === 'GET' && endpoint.route === '/endpoint-0',
      ),
    ).toEqual(
      expect.objectContaining({
        count: 2,
        maxDurationMs: 25,
        lastDurationMs: 25,
      }),
    );

    vi.advanceTimersByTime(60_000);

    recordRequestEndpointMetric({
      method: 'DELETE',
      route: '/overflow-c',
      status: 500,
      durationMs: 20,
    });

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('resets the process-lifetime snapshot for tests', () => {
    recordRequestEndpointMetric({
      method: 'GET',
      route: '/api/tasks/:taskId/messages',
      status: 200,
      durationMs: 100,
    });

    vi.advanceTimersByTime(30_000);
    resetRequestEndpointMetricsForTests();

    expect(getRequestEndpointMetricsSnapshot()).toEqual({
      sinceStartedAt: '2026-03-21T06:00:30.000Z',
      totalRequests: 0,
      trackedEndpointCount: 0,
      overflowedUniqueEndpointCount: 0,
      overflowedRequestCount: 0,
      endpoints: [],
    });
  });
});

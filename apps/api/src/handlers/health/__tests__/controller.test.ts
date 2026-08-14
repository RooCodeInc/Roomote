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

const redisGetMock = vi.hoisted(() => vi.fn());
const whereMock = vi.hoisted(() => vi.fn());
const fromMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })));
const selectMock = vi.hoisted(() => vi.fn(() => ({ from: fromMock })));
const sqlTagMock = vi.hoisted(() =>
  Object.assign(
    vi.fn(() => ({ kind: 'sql' })),
    {
      raw: vi.fn((value: string) => value),
    },
  ),
);

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: envMock,
  };
});

vi.mock('@roomote/redis', () => ({
  REDIS_KEYS: {
    CONTROLLER_HEARTBEAT: 'controller:heartbeat',
  },
  getRedis: () => ({
    get: redisGetMock,
  }),
}));

vi.mock('@roomote/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/types')>();

  return {
    ...actual,
    STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES: 10,
    STUCK_IN_QUEUE_THRESHOLD_MINUTES: 60,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    select: selectMock,
  },
  sql: sqlTagMock,
  taskRuns: {
    id: 'id',
    createdAt: 'createdAt',
    dequeuedAt: 'dequeuedAt',
    startedAt: 'startedAt',
    canceledAt: 'canceledAt',
    completedAt: 'completedAt',
  },
  isNull: vi.fn(() => ({ kind: 'isNull' })),
  isNotNull: vi.fn(() => ({ kind: 'isNotNull' })),
  and: vi.fn(() => ({ kind: 'and' })),
  lt: vi.fn(() => ({ kind: 'lt' })),
}));

import { controllerHealth } from '../controller';

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
  app.route('/health/controller', controllerHealth);
  return app;
}

describe('controllerHealth', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T06:00:00.000Z'));
    vi.clearAllMocks();
    redisGetMock.mockResolvedValue(String(Date.now() - 2_000));
    whereMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns a healthy response when controller heartbeat and queue checks pass', async () => {
    const response = await createApp(authContext).request('/health/controller');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      server: 'controller',
      environment: {
        NODE_ENV: 'test',
        APP_ENV: 'development',
      },
      ok: true,
      error: undefined,
      timestamp: '2026-03-21T06:00:00.000Z',
    });
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('returns a redacted unhealthy response naming the failing checks to unauthenticated callers', async () => {
    whereMock.mockReset();
    whereMock
      .mockResolvedValueOnce([
        { id: 12, stuckSince: new Date('2026-03-21T04:30:00.000Z') },
        { id: 13, stuckSince: new Date('2026-03-21T04:45:00.000Z') },
      ])
      .mockResolvedValueOnce([]);

    const response = await createApp().request('/health/controller');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      server: 'controller',
      ok: false,
      timestamp: '2026-03-21T06:00:00.000Z',
      failingChecks: ['stuckInQueue'],
    });
  });

  it('reports ancient stuck rows in the summary without failing health', async () => {
    whereMock.mockReset();
    whereMock
      .mockResolvedValueOnce([
        // Stuck for ~10 hours: debris from a past incident, not a live one.
        { id: 4616, stuckSince: new Date('2026-03-20T20:00:00.000Z') },
      ])
      .mockResolvedValueOnce([
        { id: 4617, stuckSince: new Date('2026-03-20T20:00:00.000Z') },
      ]);

    const response = await createApp(authContext).request('/health/controller');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('fails health when a stuck row is fresh even if ancient rows also exist', async () => {
    whereMock.mockReset();
    whereMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 4616, stuckSince: new Date('2026-03-20T20:00:00.000Z') },
      { id: 5050, stuckSince: new Date('2026-03-21T05:30:00.000Z') },
    ]);

    const response = await createApp(authContext).request('/health/controller');

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      failingChecks?: string[];
      error?: string;
    };
    expect(body.failingChecks).toEqual(['stuckAfterDequeue']);
    // Only the fresh row is reported as failing; the ancient one is summary
    // data.
    expect(body.error).toContain('[5050]');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [message] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(message).toContain('"stuckAfterDequeueCount":1');
    expect(message).toContain('"ancientStuckAfterDequeueCount":1');
  });

  it('logs per-check timings when the controller health request is slow', async () => {
    redisGetMock.mockImplementation(async () => {
      vi.advanceTimersByTime(3_500);
      return String(Date.now() - 2_000);
    });

    const response = await createApp(authContext).request('/health/controller');

    expect(response.status).toBe(200);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

    const [message] = consoleWarnSpy.mock.calls[0] ?? [];
    expect(message).toContain('[Health Check]');
    expect(message).toContain('"route":"/health/controller"');
    expect(message).toContain('"status":"slow"');
    expect(message).toContain('"name":"controllerHeartbeat"');
    expect(message).toContain('"controllerHeartbeatAgeMs":2000');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs per-check failure details when the controller health request is unhealthy', async () => {
    whereMock.mockReset();
    whereMock
      .mockResolvedValueOnce([
        { id: 12, stuckSince: new Date('2026-03-21T04:30:00.000Z') },
        { id: 13, stuckSince: new Date('2026-03-21T04:45:00.000Z') },
      ])
      .mockResolvedValueOnce([]);

    const response = await createApp(authContext).request('/health/controller');

    expect(response.status).toBe(503);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    const [message] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(message).toContain('[Health Check]');
    expect(message).toContain('"route":"/health/controller"');
    expect(message).toContain('"status":"unhealthy"');
    expect(message).toContain('"name":"stuckInQueue"');
    expect(message).toContain('"stuckInQueueCount":2');
    expect(message).toContain('Jobs stuck in queue');
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});

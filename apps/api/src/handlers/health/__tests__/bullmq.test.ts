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
const countOverdueMock = vi.hoisted(() => vi.fn());

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: envMock,
  };
});

vi.mock('@roomote/redis', () => ({
  REDIS_KEYS: {
    BULLMQ_HEARTBEAT: 'bullmq:heartbeat',
  },
  getRedis: () => ({
    get: redisGetMock,
  }),
}));

vi.mock('@roomote/sdk/server', () => ({
  countOverdueQueuedFastAgentParentEvents: countOverdueMock,
}));

import { bullmqHealth } from '../bullmq';

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
  app.route('/health/bullmq', bullmqHealth);
  return app;
}

describe('bullmqHealth', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T18:00:00.000Z'));
    vi.clearAllMocks();
    redisGetMock.mockResolvedValue(String(Date.now() - 30_000));
    countOverdueMock.mockResolvedValue(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns healthy when the heartbeat is fresh and no queued event is overdue', async () => {
    const response = await createApp(authContext).request('/health/bullmq');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      server: 'bullmq',
      environment: { NODE_ENV: 'test', APP_ENV: 'development' },
      ok: true,
      error: undefined,
      timestamp: '2026-09-15T18:00:00.000Z',
    });
    expect(countOverdueMock).toHaveBeenCalledWith(
      new Date('2026-09-15T17:55:00.000Z'),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('reports a stale heartbeat when the worker stopped writing it', async () => {
    // The Roo Vet signature: process alive, Redis ready, job loop silent.
    redisGetMock.mockResolvedValue(String(Date.now() - 70 * 60_000));

    const response = await createApp(authContext).request('/health/bullmq');

    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('bullmq stale: last heartbeat 4200.0s ago');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [message] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(message).toContain('"name":"bullmqHeartbeat"');
    expect(message).toContain('"bullmqHeartbeatAgeMs":4200000');
  });

  it('reports a missing heartbeat as unhealthy', async () => {
    redisGetMock.mockResolvedValue(null);

    const response = await createApp(authContext).request('/health/bullmq');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'bullmq heartbeat not found in Redis',
    });
  });

  it('fails on overdue queued Session events even when the heartbeat is fresh', async () => {
    countOverdueMock.mockResolvedValue(42);

    const response = await createApp(authContext).request('/health/bullmq');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error:
        '42 queued Session event(s) waited more than 300s for the bullmq worker',
    });
    const [message] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(message).toContain('"overdueQueuedEventCount":42');
  });

  it('redacts details for unauthenticated callers', async () => {
    redisGetMock.mockResolvedValue(null);

    const response = await createApp().request('/health/bullmq');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      server: 'bullmq',
      ok: false,
      timestamp: '2026-09-15T18:00:00.000Z',
    });
  });
});

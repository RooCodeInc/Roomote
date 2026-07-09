import { Hono } from 'hono';

const envMock = vi.hoisted(() => ({
  API_HEALTH_RATE_LIMIT_PER_MINUTE: 3,
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: envMock,
  };
});

import { healthRateLimitMiddleware } from '../healthRateLimitMiddleware';

function createApp(options?: { maxTrackedClientWindows?: number }) {
  const app = new Hono();

  const healthStub = new Hono();
  healthStub.get('/', (c) => c.json({ server: 'api', ok: true }));

  // Mirrors the production mounting in server.ts: the limiter is registered
  // on the bare `/health` path while sibling health routes stay unlimited.
  app.use('/health', healthRateLimitMiddleware(options));
  app.route('/health', healthStub);
  app.route('/health/api', healthStub);
  app.route('/health/liveness', healthStub);

  return app;
}

function requestHealth(app: Hono, ip?: string) {
  return app.request(
    '/health',
    ip ? { headers: { 'x-forwarded-for': ip } } : undefined,
  );
}

describe('healthRateLimitMiddleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T06:00:00.000Z'));
    envMock.API_HEALTH_RATE_LIMIT_PER_MINUTE = 3;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the limit and rejects the next with 429 and Retry-After', async () => {
    const app = createApp();

    for (let i = 0; i < 3; i += 1) {
      const response = await requestHealth(app, '203.0.113.7');
      expect(response.status).toBe(200);
    }

    vi.advanceTimersByTime(15_000);

    const limited = await requestHealth(app, '203.0.113.7');

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('45');
    await expect(limited.json()).resolves.toEqual({
      error: 'Too many requests',
    });
  });

  it('resets the budget when the window rolls over', async () => {
    const app = createApp();

    for (let i = 0; i < 4; i += 1) {
      await requestHealth(app, '203.0.113.7');
    }

    vi.advanceTimersByTime(60_000);

    const response = await requestHealth(app, '203.0.113.7');

    expect(response.status).toBe(200);
  });

  it('tracks budgets per client IP', async () => {
    const app = createApp();

    for (let i = 0; i < 3; i += 1) {
      await requestHealth(app, '203.0.113.7');
    }

    const limited = await requestHealth(app, '203.0.113.7');
    const otherClient = await requestHealth(app, '198.51.100.9');

    expect(limited.status).toBe(429);
    expect(otherClient.status).toBe(200);
  });

  it('uses the first hop of a multi-entry x-forwarded-for header', async () => {
    const app = createApp();

    for (let i = 0; i < 3; i += 1) {
      await requestHealth(app, '203.0.113.7, 10.0.0.1');
    }

    const limited = await requestHealth(app, '203.0.113.7, 10.0.0.2');

    expect(limited.status).toBe(429);
  });

  it('falls back to a shared key when no client address is available', async () => {
    const app = createApp();

    for (let i = 0; i < 3; i += 1) {
      const response = await requestHealth(app);
      expect(response.status).toBe(200);
    }

    const limited = await requestHealth(app);

    expect(limited.status).toBe(429);
  });

  it('disables limiting when the configured limit is 0', async () => {
    envMock.API_HEALTH_RATE_LIMIT_PER_MINUTE = 0;
    const app = createApp();

    for (let i = 0; i < 10; i += 1) {
      const response = await requestHealth(app, '203.0.113.7');
      expect(response.status).toBe(200);
    }
  });

  it('evicts the earliest-tracked client when the live-window cap is reached', async () => {
    envMock.API_HEALTH_RATE_LIMIT_PER_MINUTE = 1;
    const app = createApp({ maxTrackedClientWindows: 3 });

    // Fill the cap with three live windows, one request each.
    expect((await requestHealth(app, '203.0.113.1')).status).toBe(200);
    expect((await requestHealth(app, '203.0.113.2')).status).toBe(200);
    expect((await requestHealth(app, '203.0.113.3')).status).toBe(200);

    // A fourth unique client evicts the earliest-tracked one (.1).
    expect((await requestHealth(app, '203.0.113.4')).status).toBe(200);

    // The evicted client restarts a fresh window instead of hitting its
    // exhausted budget (a second request on a live window would be 429).
    expect((await requestHealth(app, '203.0.113.1')).status).toBe(200);

    // A client whose window survived the evictions still has its count.
    expect((await requestHealth(app, '203.0.113.3')).status).toBe(429);
  });

  it('never limits the sibling health routes', async () => {
    const app = createApp();

    for (let i = 0; i < 4; i += 1) {
      await requestHealth(app, '203.0.113.7');
    }

    const alias = await requestHealth(app, '203.0.113.7');
    const apiHealth = await app.request('/health/api', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    const liveness = await app.request('/health/liveness', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(alias.status).toBe(429);
    expect(apiHealth.status).toBe(200);
    expect(liveness.status).toBe(200);
  });
});

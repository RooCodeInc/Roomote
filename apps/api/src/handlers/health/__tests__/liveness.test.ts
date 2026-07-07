import { Hono } from 'hono';
import type { Variables } from '../../../types';

const envMock = vi.hoisted(() => ({
  NODE_ENV: 'test' as 'test' | 'development' | 'production',
  APP_ENV: 'development' as
    | 'development'
    | 'preview'
    | 'production'
    | undefined,
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: envMock,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    execute: vi.fn(() => {
      throw new Error(
        'liveness must not touch the database: supervisors may restart healthy API processes when this check fails',
      );
    }),
  },
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    ping: vi.fn(() => {
      throw new Error('liveness must not touch redis');
    }),
  }),
}));

import { apiLiveness } from '../liveness';

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
  app.route('/health/liveness', apiLiveness);
  return app;
}

describe('apiLiveness', () => {
  it('returns a redacted public response without touching the database or redis', async () => {
    const app = createApp();

    const response = await app.request('/health/liveness');

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.server).toBe('api');
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('environment');
  });

  it('returns environment details to authenticated callers', async () => {
    const response = await createApp(authContext).request('/health/liveness');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      server: 'api',
      environment: {
        NODE_ENV: 'test',
        APP_ENV: 'development',
      },
      ok: true,
      timestamp: expect.any(String),
    });
  });
});

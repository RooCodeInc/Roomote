import type { Context, Next } from 'hono';
import type { Variables } from '../types';

const middlewareState = vi.hoisted(() => ({
  tokenRequestPaths: [] as string[],
}));

vi.mock('../middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware')>();

  return {
    ...actual,
    tokenAuthMiddleware:
      () => async (c: Context<{ Variables: Variables }>, next: Next) => {
        middlewareState.tokenRequestPaths.push(c.req.path);
        if (c.req.header('authorization') === 'Bearer internal-health-token') {
          c.set('authContext', {
            tokenType: 'auth',
            userId: 'user-123',
          } as Variables['authContext']);
        }
        await next();
      },
  };
});

vi.mock('@roomote/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/auth')>();

  return {
    ...actual,
    getSandboxOidcDiscoveryDocument: () => ({
      issuer: 'https://api.roomote.test',
      jwks_uri: 'https://api.roomote.test/api/oidc/jwks',
    }),
    getSandboxOidcJwks: () => ({
      keys: [{ kid: 'test-key' }],
    }),
    isSandboxOidcConfigured: () => true,
  };
});

import { createApiApp } from '../server';

describe('OIDC middleware composition', () => {
  beforeEach(() => {
    middlewareState.tokenRequestPaths = [];
  });

  it('serves OIDC discovery without token auth middleware', async () => {
    const response = await createApiApp().request(
      'http://localhost/.well-known/openid-configuration',
      {
        headers: {
          authorization: 'Bearer unexpected-client-token',
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, must-revalidate',
    );
    await expect(response.json()).resolves.toEqual({
      issuer: 'https://api.roomote.test',
      jwks_uri: 'https://api.roomote.test/api/oidc/jwks',
    });
    expect(middlewareState.tokenRequestPaths).toEqual([]);
  });

  it('serves OIDC JWKS without token auth middleware', async () => {
    const response = await createApiApp().request(
      'http://localhost/api/oidc/jwks',
      {
        headers: {
          authorization: 'Bearer unexpected-client-token',
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, must-revalidate',
    );
    await expect(response.json()).resolves.toEqual({
      keys: [{ kid: 'test-key' }],
    });
    expect(middlewareState.tokenRequestPaths).toEqual([]);
  });

  it('runs token auth middleware on health checks so authenticated callers can receive detailed diagnostics', async () => {
    const response = await createApiApp().request(
      'http://localhost/health/liveness',
      {
        headers: {
          authorization: 'Bearer internal-health-token',
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      server: 'api',
      environment: {
        NODE_ENV: expect.any(String),
        APP_ENV: expect.any(String),
      },
      ok: true,
      timestamp: expect.any(String),
    });
    expect(middlewareState.tokenRequestPaths).toEqual(['/health/liveness']);
  });

  it('lets Teams webhooks perform their own Bot Framework bearer-token validation', async () => {
    const response = await createApiApp().request(
      'http://localhost/api/webhooks/teams',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer bot-framework-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'invalid_teams_activity',
    });
    expect(middlewareState.tokenRequestPaths).toEqual([]);
  });

  it('lets Telegram webhooks perform their own secret-token validation', async () => {
    const response = await createApiApp().request(
      'http://localhost/api/webhooks/telegram',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer unexpected-client-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'telegram_webhook_secret_not_configured',
    });
    expect(middlewareState.tokenRequestPaths).toEqual([]);
  });

  it('continues to run token auth middleware for non-public API routes', async () => {
    await createApiApp().request('http://localhost/api/task-runs/123/logs');

    expect(middlewareState.tokenRequestPaths).toEqual([
      '/api/task-runs/123/logs',
    ]);
  });
});

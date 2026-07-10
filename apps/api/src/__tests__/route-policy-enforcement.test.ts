import type { Context, Next } from 'hono';

import type { Variables } from '../types';

const redisState = vi.hoisted(() => ({
  incrResult: 1,
  shouldThrow: false,
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();

  return {
    ...actual,
    getRedis: () => ({
      incr: async () => {
        if (redisState.shouldThrow) {
          throw new Error('redis unavailable');
        }

        return redisState.incrResult;
      },
      expire: async () => 1,
    }),
  };
});

vi.mock('../middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware')>();

  return {
    ...actual,
    tokenAuthMiddleware:
      () => async (c: Context<{ Variables: Variables }>, next: Next) => {
        const authHeader = c.req.header('authorization');

        if (authHeader === 'Bearer test-user-token') {
          c.set('authContext', {
            tokenType: 'auth',
            userId: 'user-123',
          } as Variables['authContext']);
        }

        if (authHeader === 'Bearer test-run-token') {
          c.set('authContext', {
            tokenType: 'run',
            runId: 999,
            userId: 'user-123',
            principal: 'user',
            version: 1,
          } as Variables['authContext']);
        }

        await next();
      },
  };
});

import { createApiApp } from '../server';
import { evaluateRoutePolicy } from '../middleware/routePolicyMiddleware';

describe('route policy enforcement', () => {
  beforeEach(() => {
    redisState.incrResult = 1;
    redisState.shouldThrow = false;
  });

  describe('default-deny for unclassified paths', () => {
    it('rejects unknown paths before any handler, even with valid credentials', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/does-not-exist',
        {
          headers: { authorization: 'Bearer test-user-token' },
        },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    });

    it('rejects unknown unauthenticated paths', async () => {
      const response = await createApiApp().request(
        'http://localhost/internal/debug',
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    });
  });

  describe('public routes', () => {
    it('serves health liveness without credentials', async () => {
      const response = await createApiApp().request(
        'http://localhost/health/liveness',
      );

      expect(response.status).toBe(200);
    });
  });

  describe('authenticated routes', () => {
    it('rejects unauthenticated task run log requests centrally', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/task-runs/123/logs',
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'authentication_required',
      });
    });

    it('rejects unauthenticated tRPC requests centrally', async () => {
      const response = await createApiApp().request(
        'http://localhost/trpc/auth.me',
        { method: 'POST', body: '{}' },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'authentication_required',
      });
    });

    it('rejects unauthenticated MCP task requests centrally', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/mcp/tasks',
        { method: 'POST', body: '{}' },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'authentication_required',
      });
    });

    it('lets run-token requests through to handler-level run scoping', async () => {
      // The token is scoped to run 999, so the handler (not the policy
      // layer) rejects access to run 123. Reaching that handler check
      // proves the central policy admitted the authenticated request.
      const response = await createApiApp().request(
        'http://localhost/api/task-runs/123/logs',
        {
          headers: { authorization: 'Bearer test-run-token' },
        },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Task run token does not match requested task run',
      });
    });
  });

  describe('task-token routes', () => {
    it('rejects unauthenticated artifact requests centrally', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/artifacts',
        { method: 'POST', body: '{}' },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'authentication_required',
      });
    });

    it('rejects user tokens on artifact routes centrally', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/artifacts',
        {
          method: 'POST',
          body: '{}',
          headers: { authorization: 'Bearer test-user-token' },
        },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'task_run_token_required',
      });
    });

    it('rejects user tokens on task artifact listing centrally', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/tasks/task-1/artifacts',
        {
          headers: { authorization: 'Bearer test-user-token' },
        },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'task_run_token_required',
      });
    });
  });

  describe('webhook routes', () => {
    it('lets webhook deliveries through to handler-level verification', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/webhooks/linear',
        {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        },
      );

      // The Linear handler rejects the delivery itself (missing
      // Linear-Delivery header) — reaching it proves the central policy
      // admitted the unauthenticated webhook request.
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Missing delivery ID',
      });
    });

    it('rate limits webhook entry points per client', async () => {
      redisState.incrResult = 100_000;

      const response = await createApiApp().request(
        'http://localhost/api/webhooks/teams/auth/resume',
        {
          method: 'POST',
          body: JSON.stringify({ state: 'state-token' }),
          headers: { 'content-type': 'application/json' },
        },
      );

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: 'rate_limited',
      });
    });

    it('fails open when the rate limit backend errors', async () => {
      redisState.shouldThrow = true;

      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      try {
        const response = await createApiApp().request(
          'http://localhost/api/webhooks/linear',
          {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          },
        );

        expect(response.status).toBe(400);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Rate limit check failed open'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('CORS preflight', () => {
    it('answers preflight requests before the policy gate', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/mcp/tasks',
        {
          method: 'OPTIONS',
          headers: {
            origin: 'http://localhost:3000',
            'access-control-request-method': 'POST',
          },
        },
      );

      expect(response.status).toBe(204);
    });
  });

  describe('evaluateRoutePolicy', () => {
    const userToken = {
      tokenType: 'auth',
      userId: 'user-123',
    } as Variables['authContext'];

    const runToken = {
      tokenType: 'run',
      runId: 42,
      userId: 'user-123',
      principal: 'user',
      version: 1,
    } as Variables['authContext'];

    it('user policy admits only user tokens', () => {
      expect(evaluateRoutePolicy('user', userToken)).toBeUndefined();
      expect(evaluateRoutePolicy('user', runToken)).toEqual({
        status: 403,
        body: { error: 'user_token_required' },
      });
      expect(evaluateRoutePolicy('user', undefined)).toEqual({
        status: 401,
        body: { error: 'authentication_required' },
      });
    });

    it('task-token policy admits only run tokens', () => {
      expect(evaluateRoutePolicy('task-token', runToken)).toBeUndefined();
      expect(evaluateRoutePolicy('task-token', userToken)).toEqual({
        status: 403,
        body: { error: 'task_run_token_required' },
      });
      expect(evaluateRoutePolicy('task-token', undefined)).toEqual({
        status: 401,
        body: { error: 'authentication_required' },
      });
    });

    it('authenticated policy admits both token types', () => {
      expect(evaluateRoutePolicy('authenticated', userToken)).toBeUndefined();
      expect(evaluateRoutePolicy('authenticated', runToken)).toBeUndefined();
      expect(evaluateRoutePolicy('authenticated', undefined)).toEqual({
        status: 401,
        body: { error: 'authentication_required' },
      });
    });

    it('public and webhook policies require no credentials', () => {
      expect(evaluateRoutePolicy('public', undefined)).toBeUndefined();
      expect(evaluateRoutePolicy('webhook', undefined)).toBeUndefined();
    });
  });
});

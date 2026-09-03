import type { Context, Next } from 'hono';
import {
  getLegacyRoomoteMcpResourceUrl,
  getRoomoteMcpProtectedResourceMetadataUrl,
  getRoomoteMcpResourceUrl,
} from '@roomote/auth';
import { Env } from '@roomote/env';

import type { Variables } from '../types';

const redisState = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  shouldThrow: false,
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();

  return {
    ...actual,
    getRedis: () => ({
      // In-memory stand-in for the atomic INCR+EXPIRE rate limit script.
      eval: async (_script: string, _numKeys: number, key: string) => {
        if (redisState.shouldThrow) {
          throw new Error('redis unavailable');
        }

        const next = (redisState.counters.get(key) ?? 0) + 1;
        redisState.counters.set(key, next);
        return next;
      },
      get: async () => null,
    }),
  };
});

vi.mock('../handlers/mcp/proxy-utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../handlers/mcp/proxy-utils')>();

  return {
    ...actual,
    assertTaskRunTokenTargetExists: vi.fn(async () => undefined),
    resolveActingUserIdOrNull: vi.fn(async (auth) =>
      auth.tokenType === 'run'
        ? 'user-123'
        : actual.resolveActingUserIdOrNull(auth),
    ),
  };
});

/**
 * Seed a rate-limit bucket for the current and next fixed windows so a
 * request issued immediately afterwards cannot slip into a fresh window.
 */
function seedRateLimitBucket(
  ruleName: string,
  keySource: string,
  bucketKey: string,
  windowSeconds: number,
  count: number,
): void {
  const windowStart = Math.floor(Date.now() / (windowSeconds * 1000));

  for (const window of [windowStart, windowStart + 1]) {
    redisState.counters.set(
      `api:route-rate-limit:${ruleName}:${keySource}:${bucketKey}:${window}`,
      count,
    );
  }
}

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

        if (authHeader === 'Bearer test-mcp-token') {
          c.set('authContext', {
            tokenType: 'mcp',
            userId: 'user-123',
            resource: getRoomoteMcpResourceUrl(
              Env.R_PUBLIC_URL ?? Env.R_APP_URL,
            ),
            scopes: ['mcp:roomote'],
            version: 1,
          } as Variables['authContext']);
        }

        if (authHeader === 'Bearer test-wrong-mcp-token') {
          c.set('authContext', {
            tokenType: 'mcp',
            userId: 'user-123',
            resource: 'https://wrong.example/mcp',
            scopes: ['mcp:roomote'],
            version: 1,
          } as Variables['authContext']);
        }

        if (authHeader === 'Bearer test-legacy-mcp-token') {
          c.set('authContext', {
            tokenType: 'mcp',
            userId: 'user-123',
            resource: getLegacyRoomoteMcpResourceUrl(Env.TRPC_URL),
            scopes: ['mcp:roomote'],
            version: 1,
          } as Variables['authContext']);
        }

        await next();
      },
  };
});

import { createApiApp } from '../server';
import { evaluateRoutePolicy } from '../middleware/routePolicyMiddleware';
import { findRoutePolicyRule } from '../route-policies';

describe('route policy enforcement', () => {
  beforeEach(() => {
    redisState.counters.clear();
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

  describe('Roomote MCP OAuth discovery', () => {
    it('publishes protected-resource metadata without authentication', async () => {
      const response = await createApiApp().request(
        'http://localhost/.well-known/oauth-protected-resource/mcp',
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        resource: getRoomoteMcpResourceUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL),
        authorization_servers: [expect.any(String)],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp:roomote'],
      });
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

    it('rejects unauthenticated MCP requests centrally with a JSON-RPC error envelope', async () => {
      const jsonRpcUnauthorized = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message: 'Unauthorized: missing or invalid bearer token',
        },
      };

      const mcpResponse = await createApiApp().request(
        'http://localhost/api/mcp/tasks',
        { method: 'POST', body: '{}' },
      );

      expect(mcpResponse.status).toBe(401);
      await expect(mcpResponse.json()).resolves.toEqual(jsonRpcUnauthorized);

      const mcpRoutingResponse = await createApiApp().request(
        'http://localhost/mcp',
        { method: 'POST', body: '{}' },
      );

      expect(mcpRoutingResponse.status).toBe(401);
      expect(mcpRoutingResponse.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${getRoomoteMcpProtectedResourceMetadataUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL)}"`,
      );
      await expect(mcpRoutingResponse.json()).resolves.toEqual(
        jsonRpcUnauthorized,
      );
    });

    it('rejects MCP OAuth tokens outside the Roomote MCP resource', async () => {
      const response = await createApiApp().request(
        'http://localhost/api/task-runs/123/logs',
        { headers: { authorization: 'Bearer test-mcp-token' } },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'mcp_token_not_allowed',
      });
    });

    it('rejects an MCP token whose audience does not match the configured resource', async () => {
      const response = await createApiApp().request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer test-wrong-mcp-token' },
        body: '{}',
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringContaining('requires a user-scoped') },
      });
    });

    it('rejects a legacy-audience token at the broad public MCP endpoint', async () => {
      const response = await createApiApp().request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer test-legacy-mcp-token' },
        body: '{}',
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringContaining('requires a user-scoped') },
      });
    });

    it('exposes member task tools only on the public /mcp endpoint', async () => {
      const request = {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-mcp-token',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      };
      const publicResponse = await createApiApp().request(
        'http://localhost/mcp',
        request,
      );
      const publicBody = (await publicResponse.json()) as {
        result?: {
          tools?: Array<{
            name: string;
            inputSchema?: {
              properties?: { action?: { enum?: string[] } };
            };
          }>;
        };
      };
      expect(publicResponse.status).toBe(200);
      expect(publicBody.result?.tools?.map((tool) => tool.name)).toContain(
        'manage_tasks',
      );
      expect(publicBody.result?.tools?.map((tool) => tool.name)).toContain(
        'manage_custom_automations',
      );
      const manageTasks = publicBody.result?.tools?.find(
        (tool) => tool.name === 'manage_tasks',
      );
      expect(manageTasks?.inputSchema?.properties?.action?.enum).toEqual(
        expect.arrayContaining([
          'start',
          'search',
          'get_summary',
          'get_messages',
          'send_message',
          'search_tasks',
          'launch',
        ]),
      );

      const sessionSearchResponse = await createApiApp().request(
        'http://localhost/mcp',
        {
          ...request,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'manage_tasks', arguments: { action: 'search' } },
          }),
        },
      );
      const sessionSearchBody = (await sessionSearchResponse.json()) as {
        result?: { structuredContent?: unknown };
      };
      expect(sessionSearchBody.result?.structuredContent).toMatchObject({
        sessions: expect.any(Array),
      });

      const taskSearchResponse = await createApiApp().request(
        'http://localhost/mcp',
        {
          ...request,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
              name: 'manage_tasks',
              arguments: { action: 'search_tasks' },
            },
          }),
        },
      );
      const taskSearchBody = (await taskSearchResponse.json()) as {
        result?: { structuredContent?: unknown };
      };
      expect(taskSearchBody.result?.structuredContent).toMatchObject({
        tasks: expect.any(Array),
      });

      const invalidTaskSearchResponse = await createApiApp().request(
        'http://localhost/mcp',
        {
          ...request,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 5,
            method: 'tools/call',
            params: {
              name: 'manage_tasks',
              arguments: {
                action: 'search_tasks',
                status: 'needs_input',
              },
            },
          }),
        },
      );
      const invalidTaskSearchBody =
        (await invalidTaskSearchResponse.json()) as {
          result?: { isError?: boolean; structuredContent?: unknown };
        };
      expect(invalidTaskSearchBody.result?.isError).toBe(true);
      expect(invalidTaskSearchBody.result?.structuredContent).toMatchObject({
        error:
          'status must be one of: active, completed, all when search resolves to tasks',
      });

      const invalidLegacySearchResponse = await createApiApp().request(
        'http://localhost/mcp',
        {
          ...request,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 6,
            method: 'tools/call',
            params: {
              name: 'manage_tasks',
              arguments: {
                action: 'search',
                pullRequest: 'owner/repo#1',
                status: 'needs_input',
              },
            },
          }),
        },
      );
      const invalidLegacySearchBody =
        (await invalidLegacySearchResponse.json()) as {
          result?: { isError?: boolean };
        };
      expect(invalidLegacySearchBody.result?.isError).toBe(true);

      const callResponse = await createApiApp().request(
        'http://localhost/mcp',
        {
          ...request,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'manage_tasks',
              arguments: { action: 'list_environments' },
            },
          }),
        },
      );
      const callBody = (await callResponse.json()) as {
        result?: { isError?: boolean; structuredContent?: unknown };
      };
      expect(callResponse.status).toBe(200);
      expect(callBody.result?.isError).not.toBe(true);
      expect(callBody.result?.structuredContent).toMatchObject({
        environments: expect.any(Array),
      });

      const legacyResponse = await createApiApp().request(
        'http://localhost/api/mcp-routing/roomote',
        {
          ...request,
          headers: {
            ...request.headers,
            authorization: 'Bearer test-user-token',
          },
        },
      );
      const legacyBody = (await legacyResponse.json()) as {
        result?: { tools?: Array<{ name: string }> };
      };
      expect(legacyResponse.status).toBe(200);
      expect(legacyBody.result?.tools?.map((tool) => tool.name)).not.toContain(
        'manage_tasks',
      );
      expect(legacyBody.result?.tools?.map((tool) => tool.name)).toContain(
        'manage_custom_automations',
      );

      const runTokenResponse = await createApiApp().request(
        'http://localhost/mcp',
        {
          ...request,
          headers: {
            ...request.headers,
            authorization: 'Bearer test-run-token',
          },
        },
      );
      expect(runTokenResponse.status).toBe(403);
      await expect(runTokenResponse.json()).resolves.toMatchObject({
        error: {
          message: expect.stringContaining(
            'member tools require a user-scoped access token',
          ),
        },
      });

      const legacyRunTokenResponse = await createApiApp().request(
        'http://localhost/api/mcp-routing/roomote',
        {
          ...request,
          headers: {
            ...request.headers,
            authorization: 'Bearer test-run-token',
          },
        },
      );
      const legacyRunTokenBody = (await legacyRunTokenResponse.json()) as {
        result?: { tools?: Array<{ name: string }> };
      };
      expect(legacyRunTokenResponse.status).toBe(200);
      expect(
        legacyRunTokenBody.result?.tools?.map((tool) => tool.name),
      ).not.toContain('manage_tasks');
      expect(
        legacyRunTokenBody.result?.tools?.map((tool) => tool.name),
      ).toContain('manage_custom_automations');
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
    it('exempts the secret-authenticated Discord worker route from shared IP limits', () => {
      expect(
        findRoutePolicyRule('/api/internal/discord/events/process'),
      ).toMatchObject({
        name: 'internal-discord-event-processing',
        policy: 'webhook',
      });
      expect(
        findRoutePolicyRule('/api/internal/discord/events/process')?.rateLimits,
      ).toBeUndefined();
    });

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
      // No client-identifying headers, so the bucket key falls back to
      // 'unknown'. Seed it past the 1200/min webhook ceiling.
      seedRateLimitBucket('webhook-linear', 'client', 'unknown', 60, 100_000);

      const response = await createApiApp().request(
        'http://localhost/api/webhooks/linear',
        {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        },
      );

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: 'rate_limited',
      });
    });

    it.each(['teams', 'slack'])(
      'keys the %s auth resume limit on the state token, not the caller',
      async (provider) => {
        const app = createApiApp();

        const requestResume = (state: string) =>
          app.request(`http://localhost/api/webhooks/${provider}/auth/resume`, {
            method: 'POST',
            body: JSON.stringify({ state }),
            headers: { 'content-type': 'application/json' },
          });

        // Hammering one token trips its 10/min bucket...
        for (let attempt = 1; attempt <= 10; attempt += 1) {
          const response = await requestResume('repeated-token');

          // The mocked Redis has no pending token stored, so admitted
          // requests reach the handler and fail there with 404.
          expect(response.status).toBe(404);
        }

        const throttled = await requestResume('repeated-token');
        expect(throttled.status).toBe(429);

        // ...while other tokens (concurrent legitimate users arriving from
        // the same web-app egress with no client headers) stay unaffected.
        const otherToken = await requestResume('different-token');
        expect(otherToken.status).toBe(404);
      },
    );

    it.each(['teams', 'slack'])(
      'applies a high global client ceiling to %s auth resume',
      async (provider) => {
        seedRateLimitBucket(
          `webhook-${provider}-auth-resume`,
          'client',
          'unknown',
          60,
          100_000,
        );

        const response = await createApiApp().request(
          `http://localhost/api/webhooks/${provider}/auth/resume`,
          {
            method: 'POST',
            body: JSON.stringify({ state: 'fresh-token' }),
            headers: { 'content-type': 'application/json' },
          },
        );

        expect(response.status).toBe(429);
      },
    );

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

    const mcpToken = {
      tokenType: 'mcp',
      userId: 'user-123',
      resource: 'https://api.example.com/mcp',
      scopes: ['mcp:roomote'],
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
      expect(evaluateRoutePolicy('authenticated', mcpToken)).toEqual({
        status: 403,
        body: { error: 'mcp_token_not_allowed' },
      });
      expect(evaluateRoutePolicy('authenticated', undefined)).toEqual({
        status: 401,
        body: { error: 'authentication_required' },
      });
    });

    it('roomote-mcp policy admits internal and scoped MCP tokens', () => {
      expect(evaluateRoutePolicy('roomote-mcp', userToken)).toBeUndefined();
      expect(evaluateRoutePolicy('roomote-mcp', runToken)).toBeUndefined();
      expect(evaluateRoutePolicy('roomote-mcp', mcpToken)).toBeUndefined();
      expect(evaluateRoutePolicy('roomote-mcp', undefined)).toEqual({
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

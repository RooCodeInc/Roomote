import { createHash } from 'node:crypto';

import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { McpAccessTokenContext, RunTokenContext } from '@roomote/types';
import { getRedis } from '@roomote/redis';

import type { Variables } from '../types';
import {
  findRoutePolicyRule,
  type RoutePolicyClass,
  type RoutePolicyRule,
  type RouteRateLimit,
} from '../route-policies';

const RATE_LIMIT_REDIS_TIMEOUT_MS = 500;

/**
 * Atomically increments the window counter and arms its TTL in one round
 * trip, so a partial failure can never leave an orphaned counter without an
 * expiry.
 */
const RATE_LIMIT_INCREMENT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

type RoutePolicyRejection = {
  status: 401 | 403;
  body: { error: string };
};

function isRunTokenContext(
  auth: Variables['authContext'],
): auth is RunTokenContext {
  return Boolean(auth && 'runId' in auth);
}

function isMcpTokenContext(
  auth: Variables['authContext'],
): auth is McpAccessTokenContext {
  return auth?.tokenType === 'mcp';
}

/**
 * Pure policy evaluation: given a route's declared policy class and the
 * request's validated auth context, decide whether the request may proceed.
 * Returns undefined when the request satisfies the policy.
 */
export function evaluateRoutePolicy(
  policy: RoutePolicyClass,
  authContext: Variables['authContext'],
): RoutePolicyRejection | undefined {
  switch (policy) {
    case 'public':
    case 'webhook':
      // Public routes need no credentials. Webhook routes authenticate each
      // delivery inside the handler (HMAC signature, shared secret, or Bot
      // Framework JWT) rather than via bearer tokens.
      return undefined;
    case 'admin':
      // Enforced by the HTTP basic-auth middleware registered on this mount
      // in `server.ts` (outside development).
      return undefined;
    case 'authenticated':
      if (!authContext) {
        return { status: 401, body: { error: 'authentication_required' } };
      }
      if (isMcpTokenContext(authContext)) {
        return { status: 403, body: { error: 'mcp_token_not_allowed' } };
      }
      return undefined;
    case 'roomote-mcp':
      if (!authContext) {
        return { status: 401, body: { error: 'authentication_required' } };
      }
      return undefined;
    case 'user':
      if (!authContext) {
        return { status: 401, body: { error: 'authentication_required' } };
      }
      if (authContext.tokenType !== 'auth') {
        return { status: 403, body: { error: 'user_token_required' } };
      }
      return undefined;
    case 'task-token':
      if (!authContext) {
        return { status: 401, body: { error: 'authentication_required' } };
      }
      if (!isRunTokenContext(authContext)) {
        return { status: 403, body: { error: 'task_run_token_required' } };
      }
      return undefined;
  }
}

function rejectionResponse(
  c: Context<{ Variables: Variables }>,
  rule: RoutePolicyRule,
  rejection: RoutePolicyRejection,
): Response {
  if (
    (rule.name === 'roomote-mcp' || rule.name === 'roomote-public-mcp') &&
    rejection.status === 401
  ) {
    const resourceMetadata = new URL(
      '/.well-known/oauth-protected-resource/mcp',
      c.req.url,
    );
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${resourceMetadata.toString()}"`,
    );
  }

  if (rule.errorFormat === 'json-rpc') {
    // Match the JSON-RPC error envelope the MCP handlers emit themselves
    // (see `handlers/mcp/proxy-utils.ts`) so Streamable HTTP clients that
    // parse the body see a consistent shape.
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: rejection.status === 401 ? -32001 : -32000,
          message:
            rejection.status === 401
              ? 'Unauthorized: missing or invalid bearer token'
              : `Forbidden: ${rejection.body.error}`,
        },
      },
      rejection.status,
    );
  }

  return c.json(rejection.body, rejection.status);
}

function resolveClientKey(c: Context<{ Variables: Variables }>): string {
  return (
    c.req.header('fly-client-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

/**
 * Derive the bucket key for a `state-token` limit from the `state` string
 * field of the JSON body. Hono caches the parsed body, so the handler can
 * still read it afterwards. Requests without a usable state token share a
 * fallback bucket; the handler rejects them as invalid anyway, and the
 * shared bucket keeps that garbage bounded.
 */
async function resolveStateTokenKey(
  c: Context<{ Variables: Variables }>,
): Promise<string> {
  let state: unknown;

  try {
    const body: unknown = await c.req.json();
    state =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { state?: unknown }).state
        : undefined;
  } catch {
    return 'malformed-body';
  }

  if (typeof state !== 'string' || state.trim() === '') {
    return 'missing-state';
  }

  // Hash so the secret token never appears in Redis keys.
  return createHash('sha256').update(state.trim()).digest('hex');
}

function resolveRateLimitBucketKey(
  c: Context<{ Variables: Variables }>,
  rateLimit: RouteRateLimit,
): Promise<string> | string {
  switch (rateLimit.keySource) {
    case 'client':
      return resolveClientKey(c);
    case 'state-token':
      return resolveStateTokenKey(c);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Rate limit check timed out')),
      timeoutMs,
    );

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

/**
 * Fixed-window rate limit backed by Redis. Fails open on Redis errors or
 * slowness so a cache outage cannot take down webhook ingestion.
 */
async function isRateLimited(
  c: Context<{ Variables: Variables }>,
  rule: RoutePolicyRule,
  rateLimit: RouteRateLimit,
): Promise<boolean> {
  try {
    const bucketKey = await resolveRateLimitBucketKey(c, rateLimit);
    const redis = getRedis();
    const windowStart = Math.floor(
      Date.now() / (rateLimit.windowSeconds * 1000),
    );
    const key = `api:route-rate-limit:${rule.name}:${rateLimit.keySource}:${bucketKey}:${windowStart}`;

    const count = await withTimeout(
      redis.eval(
        RATE_LIMIT_INCREMENT_LUA,
        1,
        key,
        String(rateLimit.windowSeconds),
      ) as Promise<number>,
      RATE_LIMIT_REDIS_TIMEOUT_MS,
    );

    return count > rateLimit.limit;
  } catch (error) {
    console.warn(
      `[RoutePolicy] Rate limit check failed open for ${rule.name}:${rateLimit.keySource}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return false;
  }
}

/**
 * Central default-deny authorization gate. Every request must match a
 * declared route policy rule; requests whose path is not covered by any rule
 * are rejected before any handler can run, and requests that do not satisfy
 * their route's declared policy are rejected with 401/403.
 */
export const routePolicyMiddleware = createMiddleware<{
  Variables: Variables;
}>(async (c, next) => {
  const rule = findRoutePolicyRule(c.req.path);

  if (!rule) {
    // Default-deny: the path is not covered by any declared route policy.
    return c.json({ error: 'not_found' }, 404);
  }

  for (const rateLimit of rule.rateLimits ?? []) {
    if (await isRateLimited(c, rule, rateLimit)) {
      return c.json({ error: 'rate_limited' }, 429);
    }
  }

  const rejection = evaluateRoutePolicy(rule.policy, c.get('authContext'));

  if (rejection) {
    return rejectionResponse(c, rule, rejection);
  }

  await next();
});

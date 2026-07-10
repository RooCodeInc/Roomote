import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { RunTokenContext } from '@roomote/types';
import { getRedis } from '@roomote/redis';

import type { Variables } from '../types';
import {
  findRoutePolicyRule,
  type RoutePolicyClass,
  type RoutePolicyRule,
} from '../route-policies';

const RATE_LIMIT_REDIS_TIMEOUT_MS = 500;

type RoutePolicyRejection = {
  status: 401 | 403;
  body: { error: string };
};

function isRunTokenContext(
  auth: Variables['authContext'],
): auth is RunTokenContext {
  return Boolean(auth && 'runId' in auth);
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
      return undefined;
    case 'user':
      if (!authContext) {
        return { status: 401, body: { error: 'authentication_required' } };
      }
      if (isRunTokenContext(authContext)) {
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

function resolveClientKey(c: Context<{ Variables: Variables }>): string {
  return (
    c.req.header('fly-client-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
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
 * Fixed-window per-client rate limit backed by Redis. Fails open on Redis
 * errors or slowness so a cache outage cannot take down webhook ingestion.
 */
async function isRateLimited(
  rule: RoutePolicyRule,
  clientKey: string,
): Promise<boolean> {
  const rateLimit = rule.rateLimit;

  if (!rateLimit) {
    return false;
  }

  try {
    const redis = getRedis();
    const windowStart = Math.floor(
      Date.now() / (rateLimit.windowSeconds * 1000),
    );
    const key = `api:route-rate-limit:${rule.name}:${clientKey}:${windowStart}`;

    const count = await withTimeout(
      (async () => {
        const value = await redis.incr(key);

        if (value === 1) {
          await redis.expire(key, rateLimit.windowSeconds);
        }

        return value;
      })(),
      RATE_LIMIT_REDIS_TIMEOUT_MS,
    );

    return count > rateLimit.limit;
  } catch (error) {
    console.warn(
      `[RoutePolicy] Rate limit check failed open for ${rule.name}: ${
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

  if (rule.rateLimit && (await isRateLimited(rule, resolveClientKey(c)))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const rejection = evaluateRoutePolicy(rule.policy, c.get('authContext'));

  if (rejection) {
    return c.json(rejection.body, rejection.status);
  }

  await next();
});

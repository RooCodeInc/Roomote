import crypto from 'node:crypto';

import { getRedis, type Redis } from './index';

// ---------------------------------------------------------------------------
// Lua script: conditionally delete a key only if its value matches the owner.
// Prevents releasing a lock that has already been acquired by another process.
// ---------------------------------------------------------------------------

const RELEASE_SCRIPT = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;
const RENEW_SCRIPT = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end`;

async function safeRelease(
  redis: Redis,
  key: string,
  ownerId: string,
): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, key, ownerId).catch(() => {});
}

async function safeRenew(
  redis: Redis,
  key: string,
  ownerId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const renewed = await redis
    .eval(RENEW_SCRIPT, 1, key, ownerId, ttlSeconds.toString())
    .catch(() => 0);

  return renewed === 1;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Outcome of a lease renewal that distinguishes definitive ownership loss
 * from a transient Redis failure, so holders of long-lived leases can
 * tolerate a blip without tearing down still-valid work.
 */
export type RedisLockRenewResult = 'renewed' | 'lost' | 'error';

export type RedisLockHandle = (() => Promise<void>) & {
  renew: (ttlSeconds?: number) => Promise<boolean>;
  renewDetailed: (ttlSeconds?: number) => Promise<RedisLockRenewResult>;
};

export type ContentionResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; value: T }
  | { acquired: false; value: undefined };

export interface ContentionOptions<T> {
  /** Lock TTL in seconds (default: 30). */
  ttlSeconds?: number;
  poll?: {
    /** Milliseconds between poll attempts (default: 500). */
    intervalMs?: number;
    /** Maximum number of poll attempts (default: 10). */
    maxAttempts?: number;
  };
  /** Called once when the lock is acquired. Must return the resource. */
  onAcquired: () => Promise<T>;
  /**
   * Called repeatedly when the lock is held by another process.
   * Return a value to stop polling, or `undefined` to keep trying.
   */
  onContended: () => Promise<T | undefined>;
  /** Optional Redis instance override (defaults to `getRedis()`). */
  redis?: Redis;
}

export interface RedisLockOptions {
  /** Lock TTL in seconds (default: 30). */
  ttlSeconds?: number;
  /** Optional Redis instance override (defaults to `getRedis()`). */
  redis?: Redis;
}

// ---------------------------------------------------------------------------
// Layer 1: withRedisLock
// ---------------------------------------------------------------------------

/**
 * Acquire a Redis lock and return an explicit release function.
 *
 * Unlike {@link withRedisLock}, this helper is intended for short-lived
 * operations that should actively release the lock on completion instead of
 * leaving cleanup to TTL expiry.
 */
export async function acquireRedisLock(
  key: string,
  options: RedisLockOptions = {},
): Promise<RedisLockHandle | null> {
  const ttl = options.ttlSeconds ?? 30;
  const redis = options.redis ?? getRedis();
  const ownerId = crypto.randomUUID();

  const acquired = await redis.set(key, ownerId, 'EX', ttl, 'NX');

  if (!acquired) {
    return null;
  }

  const release = (async () => {
    await safeRelease(redis, key, ownerId);
  }) as RedisLockHandle;

  release.renew = async (ttlSeconds = ttl) =>
    safeRenew(redis, key, ownerId, ttlSeconds);

  release.renewDetailed = async (ttlSeconds = ttl) => {
    try {
      const renewed = await redis.eval(
        RENEW_SCRIPT,
        1,
        key,
        ownerId,
        ttlSeconds.toString(),
      );
      return renewed === 1 ? 'renewed' : 'lost';
    } catch {
      return 'error';
    }
  };

  return release;
}

/**
 * Try to acquire a Redis lock and run `fn` if successful.
 *
 * - If acquired, runs `fn()`. On success the lock expires naturally via TTL
 *   (useful for creation-guarding locks where you want the lock to outlive the
 *   work briefly). On error the lock is released immediately and the error is
 *   re-thrown.
 * - If not acquired, returns `{ acquired: false }` immediately.
 */
export async function withRedisLock<T>(
  key: string,
  options: RedisLockOptions,
  fn: () => Promise<T>,
): Promise<LockResult<T>> {
  const ttl = options.ttlSeconds ?? 30;
  const redis = options.redis ?? getRedis();
  const ownerId = crypto.randomUUID();

  const acquired = await redis.set(key, ownerId, 'EX', ttl, 'NX');

  if (!acquired) {
    return { acquired: false };
  }

  try {
    const value = await fn();
    return { acquired: true, value };
  } catch (error) {
    // Release immediately on failure so another caller can retry.
    // Uses a conditional delete to avoid releasing a lock held by another process
    // (e.g. if our TTL expired and someone else acquired it while fn() was running).
    await safeRelease(redis, key, ownerId);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Layer 2: withContention
// ---------------------------------------------------------------------------

/**
 * Leader/follower pattern built on top of {@link withRedisLock}.
 *
 * - If the lock is acquired, runs `onAcquired()` (the "leader" path).
 * - If the lock is held by another process, polls `onContended()` at a
 *   configurable interval until it returns a non-`undefined` value or the
 *   maximum number of attempts is exhausted.
 *
 * Returns the resource from whichever path produced it, or
 * `{ acquired: false, value: undefined }` if polling was exhausted.
 */
export async function withContention<T>(
  key: string,
  options: ContentionOptions<T>,
): Promise<ContentionResult<T>> {
  const redis = options.redis ?? getRedis();
  const ttlSeconds = options.ttlSeconds ?? 30;
  const intervalMs = options.poll?.intervalMs ?? 500;
  const maxAttempts = options.poll?.maxAttempts ?? 10;

  const lockResult = await withRedisLock(key, { ttlSeconds, redis }, async () =>
    options.onAcquired(),
  );

  if (lockResult.acquired) {
    return { acquired: true, value: lockResult.value };
  }

  // Contended path: poll for the resource the leader is creating.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const value = await options.onContended();

    if (value !== undefined) {
      return { acquired: false, value };
    }
  }

  return { acquired: false, value: undefined };
}

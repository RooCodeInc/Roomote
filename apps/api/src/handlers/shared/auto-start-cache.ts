import type { Redis } from '@roomote/redis';
import { AUTO_START_EMPTY_SENTINEL } from '@roomote/redis';

import { apiLogger } from '../../logging.js';

type AutoStartChannelCacheResult =
  | { status: 'hit' }
  | { status: 'empty' }
  | { status: 'miss' }
  | { status: 'mismatch' }
  | { status: 'legacy' };

function isRedisWrongTypeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('WRONGTYPE');
}

async function hasExpiringAutoStartChannelCache(params: {
  redis: Redis;
  cacheKey: string;
  logContext: string;
}): Promise<boolean> {
  const ttlSeconds = await params.redis.ttl(params.cacheKey);

  if (ttlSeconds >= 0) {
    return true;
  }

  if (ttlSeconds === -1) {
    apiLogger.warn(
      `[${params.logContext}] Found non-expiring auto-start channel cache; treating as cache miss`,
    );
  }

  return false;
}

/**
 * Fast-reject membership check against a provider's auto-start channel cache
 * (a Redis SET of enabled channel ids with an empty sentinel, synced on
 * settings saves and refreshed on stale reads). Shared by every chat
 * provider's channel auto-start consume path.
 */
export async function checkAutoStartChannelCache(params: {
  redis: Redis;
  cacheKey: string;
  channelId: string;
  logContext: string;
}): Promise<AutoStartChannelCacheResult> {
  try {
    const membership = await params.redis.sismember(
      params.cacheKey,
      params.channelId,
    );

    if (membership === 1) {
      return (await hasExpiringAutoStartChannelCache(params))
        ? { status: 'hit' }
        : { status: 'legacy' };
    }

    const emptySentinelMembership = await params.redis.sismember(
      params.cacheKey,
      AUTO_START_EMPTY_SENTINEL,
    );

    if (emptySentinelMembership === 1) {
      return (await hasExpiringAutoStartChannelCache(params))
        ? { status: 'empty' }
        : { status: 'legacy' };
    }

    const count = await params.redis.scard(params.cacheKey);
    if (count === 0) {
      return { status: 'miss' };
    }

    return (await hasExpiringAutoStartChannelCache(params))
      ? { status: 'mismatch' }
      : { status: 'legacy' };
  } catch (error) {
    if (!isRedisWrongTypeError(error)) {
      throw error;
    }

    apiLogger.warn(
      `[${params.logContext}] Found legacy auto-start channel cache key type; treating as cache miss`,
    );
    return { status: 'legacy' };
  }
}

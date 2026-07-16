import { Redis } from 'ioredis';

import { Env } from '@roomote/env';

export type { Redis } from 'ioredis';

export const REDIS_KEYS = {
  MENTIONED_THREADS: 'slack:mentioned_threads',
  PENDING_WORKSPACE_SELECTIONS: 'slack:pending_workspace_selections',
  SLACK_AUTO_START_CHANNEL: 'slack:auto-start-channel',
  CONTROLLER_HEARTBEAT: 'controller:heartbeat',
} as const;

export const SLACK_AUTO_START_EMPTY_SENTINEL = '__roomote_empty__';
export const SLACK_AUTO_START_CHANNEL_CACHE_TTL_SECONDS = 60;

export async function syncSlackAutoStartChannelCacheBestEffort(params: {
  redis: Redis;
  key: string;
  channelIds: string[];
  onError?: (error: unknown) => void;
}): Promise<void> {
  try {
    await params.redis.del(params.key);

    await params.redis.sadd(
      params.key,
      ...(params.channelIds.length > 0
        ? params.channelIds
        : [SLACK_AUTO_START_EMPTY_SENTINEL]),
    );
    await params.redis.expire(
      params.key,
      SLACK_AUTO_START_CHANNEL_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    params.onError?.(error);
  }
}

let redis: Redis | null = null;

function resolveRedisUrl(): string {
  // In apps/web on Vercel, dotenvx decrypts into process.env at runtime after
  // @roomote/env may already have snapshotted an earlier value.
  const redisUrl = process.env.REDIS_URL?.trim() || Env.REDIS_URL?.trim();

  if (!redisUrl) {
    throw new Error('REDIS_URL is not configured');
  }

  return redisUrl;
}

export const getRedis = () => {
  if (!redis) {
    redis = new Redis(resolveRedisUrl(), {
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
    });
  }

  return redis;
};

export { acquireRedisLock, withRedisLock, withContention } from './lock';
export type {
  RedisLockOptions,
  RedisLockHandle,
  RedisLockRenewResult,
  LockResult,
  ContentionResult,
  ContentionOptions,
} from './lock';

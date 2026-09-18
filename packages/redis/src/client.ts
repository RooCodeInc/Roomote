import { Redis } from 'ioredis';

import { Env } from '@roomote/env';

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

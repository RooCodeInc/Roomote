import { Redis } from 'ioredis';

import { Env } from '@roomote/env';

let redis: Redis | null = null;
let mcpOAuthRedis: Redis | null = null;

/** Credential checks must fail promptly rather than queue forever on outages. */
export function getMcpOAuthRedis(): Redis {
  mcpOAuthRedis ??= new Redis(resolveRedisUrl(), {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
  return mcpOAuthRedis;
}

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

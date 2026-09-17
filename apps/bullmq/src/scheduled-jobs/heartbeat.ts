import { REDIS_KEYS } from '@roomote/redis';

import { getRedis } from '../redis';

/**
 * The liveness heartbeat outlives a few missed ticks so a brief Redis blip
 * does not read as a dead worker, but it expires well before anyone would
 * mistake a stale value for a live one.
 */
const BULLMQ_HEARTBEAT_TTL_SECONDS = 10 * 60;

/**
 * Runs through the scheduler Worker every minute. Because the write happens
 * inside a processed job, a fresh timestamp proves the worker is actually
 * draining its queue; a process that is alive but no longer processing jobs
 * (which Railway and the Redis client both report as healthy) stops
 * refreshing it, and `/health/bullmq` on the api reports it stale.
 */
export const heartbeatJob = async () => {
  const redis = getRedis();
  const now = Date.now();

  await redis.set(
    REDIS_KEYS.BULLMQ_HEARTBEAT,
    now.toString(),
    'EX',
    BULLMQ_HEARTBEAT_TTL_SECONDS,
  );

  // Legacy keys kept for the queue dashboard and older tooling.
  const timestamp = new Date(now).toISOString();
  const key = 'scheduler:last-update';
  await redis.set(key, timestamp, 'EX', 24 * 60 * 60);

  const historyKey = 'scheduler:update-history';
  await redis.lpush(historyKey, timestamp);
  await redis.ltrim(historyKey, 0, 9);
};

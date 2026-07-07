import { getRedis } from '../redis';

export const heartbeatJob = async () => {
  const redis = getRedis();

  // Update Redis with the current timestamp.
  const timestamp = new Date().toISOString();
  const key = 'scheduler:last-update';
  await redis.set(key, timestamp, 'EX', 24 * 60 * 60);
  await redis.expire(key, 24 * 60 * 60); // 24 hour TTL.

  // Also store a history of recent updates (keep last 10).
  const historyKey = 'scheduler:update-history';
  await redis.lpush(historyKey, timestamp);
  await redis.ltrim(historyKey, 0, 9);
  console.log(`[heartbeat] ${timestamp}`);
};

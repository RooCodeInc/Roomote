import Redis, { RedisOptions } from 'ioredis';

import { Env } from '@roomote/env';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (redis) {
    return redis;
  }

  const url = new URL(Env.REDIS_URL);

  const options: RedisOptions = {
    host: url.hostname,
    port: parseInt(url.port || '6379'),
    maxRetriesPerRequest: null, // Required by BullMQ.
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 50, 5_000);
      console.log(`retrying connection (attempt ${times}), delay: ${delay}ms`);
      return delay;
    },
    lazyConnect: false,
  };

  if (url.username) {
    options.username = url.username;
  }

  if (url.password) {
    options.password = url.password;
  }

  if (url.protocol === 'rediss:') {
    options.tls = {};
  }

  console.log(
    `connecting to ${url.hostname}:${url.port || '6379'}, tls=${!!options.tls}`,
  );

  redis = new Redis(options);

  redis.on('connect', () => console.log(`connected successfully`));
  redis.on('ready', () => console.log(`ready to accept commands`));
  redis.on('close', () => console.log(`connection closed`));
  redis.on('error', (err: Error) => console.error(`connection error:`, err));

  redis.on('reconnecting', (delay: number) =>
    console.log(`reconnecting in ${delay}ms`),
  );

  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    try {
      await redis.quit();
      console.log(`connection closed gracefully`);
    } catch (error) {
      console.error(`error closing connection:`, error);
      redis.disconnect();
      console.log(`connection forcefully disconnected`);
    }
  }
}

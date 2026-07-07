import { getRedis } from '@roomote/redis';

export async function setWithExpiry(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  await getRedis().setex(key, ttlSeconds, value);
}

export async function get(key: string): Promise<string | null> {
  return getRedis().get(key);
}

export async function del(key: string): Promise<void> {
  await getRedis().del(key);
}

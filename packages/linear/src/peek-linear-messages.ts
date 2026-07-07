import { getRedis } from '@roomote/redis';

/**
 * Non-destructively check if there are pending Linear messages for a cloud job.
 * Uses LLEN to check the queue length without reading or deleting any messages.
 * This is safe to call before committing to a resume job creation.
 */
export async function peekLinearMessageCount(
  cloudJobId: number,
): Promise<number> {
  const redis = getRedis();
  const key = `linear:messages:${cloudJobId}`;
  return redis.llen(key);
}

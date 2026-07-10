import { getRedis } from '@roomote/redis';

/**
 * Non-destructively check if there are pending Linear messages for a task run.
 * Uses LLEN to check the queue length without reading or deleting any messages.
 * This is safe to call before committing to a resume task run creation.
 */
export async function peekLinearMessageCount(runId: number): Promise<number> {
  const redis = getRedis();
  const key = `linear:messages:${runId}`;
  return redis.llen(key);
}

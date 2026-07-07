import type { RedisClient } from './types';

import {
  CONFLICT_LOCK_PREFIX,
  CONFLICT_LOCK_TTL_SECONDS,
  LOG_PREFIX,
} from './constants';

/**
 * Acquire a per-repo concurrency lock so that only one conflict-resolution
 * run executes at a time per repository.
 *
 * Uses Redis SET NX EX for atomic acquire + TTL safety net.
 *
 * @returns A release function if the lock was acquired, or `null` if another
 *          run already holds the lock.
 */
export async function acquireRepoLock(
  redis: RedisClient,
  owner: string,
  repo: string,
): Promise<(() => Promise<void>) | null> {
  const key = `${CONFLICT_LOCK_PREFIX}${owner}/${repo}`;
  const lockValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const acquired = await redis.set(
    key,
    lockValue,
    'EX',
    CONFLICT_LOCK_TTL_SECONDS,
    'NX',
  );

  if (acquired !== 'OK') {
    console.log(
      `${LOG_PREFIX} Skipping ${owner}/${repo} — another resolution run is in progress`,
    );
    return null;
  }

  // Return a release function that only deletes if the value still matches
  // (prevents releasing someone else's lock if ours expired).
  return async () => {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      await redis.eval(script, 1, key, lockValue);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Failed to release lock for ${owner}/${repo}:`,
        error instanceof Error ? error.message : error,
      );
    }
  };
}

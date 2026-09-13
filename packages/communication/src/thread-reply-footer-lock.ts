import crypto from 'node:crypto';

import { getRedis } from '@roomote/redis';

import type { ThreadReplyFooterLock } from './thread-reply-footer-state';

const THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS = 30;
const THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS = 40;
const THREAD_REPLY_FOOTER_LOCK_RETRY_MS = 100;
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

export const THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE =
  'Timed out acquiring thread reply footer lock';

/** Replies wait out provider edits; refreshes override attempts to try once. */
export async function withThreadReplyFooterLock<T>(params: {
  lockKey: string;
  maxAcquireAttempts?: number;
  fn: (
    assertLock: () => Promise<void>,
    lock: ThreadReplyFooterLock,
  ) => Promise<T>;
}): Promise<T> {
  const redis = getRedis();
  const maxAcquireAttempts =
    params.maxAcquireAttempts ?? THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    const ownerId = crypto.randomUUID();
    const acquired = await redis.set(
      params.lockKey,
      ownerId,
      'EX',
      THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS,
      'NX',
    );

    if (acquired) {
      let lost = false;
      const assertLock = async () => {
        if (lost || (await redis.get(params.lockKey)) !== ownerId) {
          lost = true;
          throw new Error('Thread reply footer lock lease lost');
        }
      };
      let renewal = Promise.resolve();
      const timer = setInterval(
        () => {
          renewal = renewal
            .then(async () => {
              const renewed = await redis.eval(
                "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end",
                1,
                params.lockKey,
                ownerId,
                THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS,
              );
              if (!renewed) lost = true;
            })
            .catch(() => {
              lost = true;
            });
        },
        (THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS * 1000) / 3,
      );
      timer.unref();
      try {
        return await params.fn(assertLock, { key: params.lockKey, ownerId });
      } finally {
        clearInterval(timer);
        await renewal;
        await redis
          .eval(RELEASE_LOCK_SCRIPT, 1, params.lockKey, ownerId)
          .catch(() => {});
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, THREAD_REPLY_FOOTER_LOCK_RETRY_MS),
    );
  }

  throw new Error(THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE);
}

/** Background refreshes yield immediately instead of delaying a reply. */
export async function tryThreadReplyFooterLock<T>(params: {
  lockKey: string;
  fn: (
    assertLock: () => Promise<void>,
    lock: ThreadReplyFooterLock,
  ) => Promise<T>;
}): Promise<{ acquired: true; value: T } | { acquired: false }> {
  try {
    const value = await withThreadReplyFooterLock({
      lockKey: params.lockKey,
      maxAcquireAttempts: 1,
      fn: params.fn,
    });
    return { acquired: true, value };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE
    )
      return { acquired: false };
    throw error;
  }
}

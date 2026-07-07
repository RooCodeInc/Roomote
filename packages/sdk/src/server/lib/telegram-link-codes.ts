import { randomBytes } from 'node:crypto';

import { getRedis } from '@roomote/redis';

const TELEGRAM_LINK_CODE_PREFIX = 'link-';
const TELEGRAM_LINK_CODE_REDIS_PREFIX = 'telegram:link-code:';
export const TELEGRAM_LINK_CODE_TTL_SECONDS = 10 * 60;

/**
 * Codes double as Telegram deep-link payloads (t.me/<bot>?start=<code>),
 * which allow only [A-Za-z0-9_-] and at most 64 characters.
 */
const TELEGRAM_LINK_CODE_PATTERN = /^link-[A-Za-z0-9_-]{16,}$/;

export function isTelegramLinkCode(value: string): boolean {
  return TELEGRAM_LINK_CODE_PATTERN.test(value.trim());
}

export async function createTelegramLinkCode(userId: string): Promise<{
  code: string;
  expiresInSeconds: number;
}> {
  const code = `${TELEGRAM_LINK_CODE_PREFIX}${randomBytes(12).toString('base64url')}`;
  const redis = getRedis();

  await redis.set(
    `${TELEGRAM_LINK_CODE_REDIS_PREFIX}${code}`,
    userId,
    'EX',
    TELEGRAM_LINK_CODE_TTL_SECONDS,
  );

  return { code, expiresInSeconds: TELEGRAM_LINK_CODE_TTL_SECONDS };
}

/**
 * Puts a consumed code back (with a fresh TTL) when linking fails after the
 * one-shot GETDEL, so a transient error does not burn the code.
 */
export async function restoreTelegramLinkCode(
  code: string,
  userId: string,
): Promise<void> {
  const redis = getRedis();

  await redis.set(
    `${TELEGRAM_LINK_CODE_REDIS_PREFIX}${code.trim()}`,
    userId,
    'EX',
    TELEGRAM_LINK_CODE_TTL_SECONDS,
  );
}

/** One-shot: a code is deleted the moment it resolves. */
export async function consumeTelegramLinkCode(
  code: string,
): Promise<string | null> {
  if (!isTelegramLinkCode(code)) {
    return null;
  }

  const redis = getRedis();
  const userId = await redis.getdel(
    `${TELEGRAM_LINK_CODE_REDIS_PREFIX}${code.trim()}`,
  );

  return userId || null;
}

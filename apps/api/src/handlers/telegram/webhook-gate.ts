import crypto from 'node:crypto';

import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';

const TELEGRAM_UPDATE_DEDUP_PREFIX = 'telegram:update:';
const TELEGRAM_UPDATE_DEDUP_TTL_SECONDS = 5 * 60;
const TELEGRAM_IMPLICIT_TOPIC_PREFIX = 'telegram:implicit-topic:';
const TELEGRAM_IMPLICIT_TOPIC_TTL_SECONDS = 60 * 60;

function implicitTopicKey(chatId: string, threadId: string): string {
  return `${TELEGRAM_IMPLICIT_TOPIC_PREFIX}${chatId}:${threadId}`;
}

export async function rememberTelegramImplicitTopic(input: {
  chatId: string;
  threadId: string;
}): Promise<void> {
  const redis = getRedis();
  await redis.set(
    implicitTopicKey(input.chatId, input.threadId),
    '1',
    'EX',
    TELEGRAM_IMPLICIT_TOPIC_TTL_SECONDS,
  );
}

export async function consumeTelegramImplicitTopic(input: {
  chatId: string;
  threadId: string;
}): Promise<boolean> {
  const redis = getRedis();
  return Boolean(
    await redis.getdel(implicitTopicKey(input.chatId, input.threadId)),
  );
}

function safeCompareSecret(
  expected: string | undefined,
  actual: string | undefined,
): boolean {
  if (!expected || !actual) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export async function verifyTelegramWebhookSecret(
  actual: string | undefined,
): Promise<{
  ok: false;
  status: 401 | 503;
  error: string;
} | null> {
  const { webhookSecret } = await resolveTelegramRuntimeCredentials();

  if (!webhookSecret) {
    return {
      ok: false,
      status: 503,
      error: 'telegram_webhook_secret_not_configured',
    };
  }

  if (!safeCompareSecret(webhookSecret, actual)) {
    return {
      ok: false,
      status: 401,
      error: 'telegram_webhook_unauthorized',
    };
  }

  return null;
}

export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  const redis = getRedis();
  const claimed = await redis.set(
    `${TELEGRAM_UPDATE_DEDUP_PREFIX}${updateId}`,
    '1',
    'EX',
    TELEGRAM_UPDATE_DEDUP_TTL_SECONDS,
    'NX',
  );

  return Boolean(claimed);
}

export async function releaseTelegramUpdateClaim(
  updateId: number,
): Promise<void> {
  await getRedis().del(`${TELEGRAM_UPDATE_DEDUP_PREFIX}${updateId}`);
}

const TELEGRAM_LINK_NUDGE_PREFIX = 'telegram:link-nudge:';
const TELEGRAM_LINK_NUDGE_USER_TTL_SECONDS = 6 * 60 * 60;
const TELEGRAM_LINK_NUDGE_CHAT_TTL_SECONDS = 15 * 60;

/**
 * Rate-limits the group "link your account" nudge so it cannot be used to
 * make the bot spam: at most one nudge per sender per chat every 6 hours,
 * and at most one nudge per chat every 15 minutes regardless of sender.
 * Fails quiet — if Redis is unavailable, no nudge is sent.
 */
export async function claimTelegramLinkNudge(input: {
  chatId: string;
  telegramUserId: string | undefined;
}): Promise<boolean> {
  try {
    const redis = getRedis();
    const userKey = `${TELEGRAM_LINK_NUDGE_PREFIX}user:${input.chatId}:${input.telegramUserId ?? 'unknown'}`;
    const chatKey = `${TELEGRAM_LINK_NUDGE_PREFIX}chat:${input.chatId}`;

    const userClaimed = await redis.set(
      userKey,
      '1',
      'EX',
      TELEGRAM_LINK_NUDGE_USER_TTL_SECONDS,
      'NX',
    );

    if (!userClaimed) {
      return false;
    }

    const chatClaimed = await redis.set(
      chatKey,
      '1',
      'EX',
      TELEGRAM_LINK_NUDGE_CHAT_TTL_SECONDS,
      'NX',
    );

    if (!chatClaimed) {
      // Refund the sender's window so they still get a nudge once the
      // chat-wide window reopens.
      await redis.del(userKey);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

import { randomBytes } from 'node:crypto';

import { getRedis } from '@roomote/redis';

type CommunicationLinkProvider = 'discord' | 'telegram';

const LINK_CODE_PREFIX = 'link-';
const LINK_CODE_PATTERN = /^link-[A-Za-z0-9_-]{16,}$/;
export const COMMUNICATION_LINK_CODE_TTL_SECONDS = 10 * 60;

function redisKey(provider: CommunicationLinkProvider, code: string): string {
  return `${provider}:link-code:${code.trim()}`;
}

/**
 * Link codes are safe in Telegram deep-link payloads and Discord slash-command
 * string options: ASCII URL-safe characters, no whitespace, and well below
 * either platform's limit.
 */
export function isCommunicationLinkCode(value: string): boolean {
  return LINK_CODE_PATTERN.test(value.trim());
}

export async function createCommunicationLinkCode(
  provider: CommunicationLinkProvider,
  userId: string,
): Promise<{ code: string; expiresInSeconds: number }> {
  const code = `${LINK_CODE_PREFIX}${randomBytes(12).toString('base64url')}`;
  await getRedis().set(
    redisKey(provider, code),
    userId,
    'EX',
    COMMUNICATION_LINK_CODE_TTL_SECONDS,
  );

  return { code, expiresInSeconds: COMMUNICATION_LINK_CODE_TTL_SECONDS };
}

/** Restore a code after a transient linking failure following one-shot use. */
export async function restoreCommunicationLinkCode(
  provider: CommunicationLinkProvider,
  code: string,
  userId: string,
): Promise<void> {
  await getRedis().set(
    redisKey(provider, code),
    userId,
    'EX',
    COMMUNICATION_LINK_CODE_TTL_SECONDS,
  );
}

/** One-shot: a code is deleted the moment it resolves. */
export async function consumeCommunicationLinkCode(
  provider: CommunicationLinkProvider,
  code: string,
): Promise<string | null> {
  if (!isCommunicationLinkCode(code)) {
    return null;
  }

  return (await getRedis().getdel(redisKey(provider, code))) || null;
}

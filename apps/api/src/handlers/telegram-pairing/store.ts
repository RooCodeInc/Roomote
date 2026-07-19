import crypto from 'node:crypto';

import { getRedis } from '@roomote/redis';

/**
 * Redis-backed store for Telegram managed-bot pairings. A pairing lives for
 * the few minutes between "admin clicked Create bot automatically" and "the
 * manager bot received the managed_bot update and exported the child token".
 * The suggested username is the only correlation key between the two halves,
 * so records are looked up both by pairing id (client polling) and by
 * username (manager webhook).
 */

const PAIRING_ID_PREFIX = 'telegram-pairing:id:';
const PAIRING_USERNAME_PREFIX = 'telegram-pairing:username:';

export const TELEGRAM_PAIRING_TTL_SECONDS = 15 * 60;

type TelegramPairingRecord = {
  pairingId: string;
  /** SHA-256 hex of the bearer poll token; the raw token is never stored. */
  pollTokenHash: string;
  suggestedUsername: string;
  status: 'pending' | 'ready';
  token?: string;
  botUsername?: string;
  ownerTelegramUserId?: string;
  ownerTelegramUsername?: string;
};

export function hashPollToken(pollToken: string): string {
  return crypto.createHash('sha256').update(pollToken).digest('hex');
}

export async function createPairingRecord(input: {
  suggestedUsername: string;
}): Promise<{ record: TelegramPairingRecord; pollToken: string }> {
  const pairingId = crypto.randomUUID();
  const pollToken = crypto.randomBytes(32).toString('hex');
  const record: TelegramPairingRecord = {
    pairingId,
    pollTokenHash: hashPollToken(pollToken),
    suggestedUsername: input.suggestedUsername,
    status: 'pending',
  };

  const redis = getRedis();
  await redis.set(
    `${PAIRING_ID_PREFIX}${pairingId}`,
    JSON.stringify(record),
    'EX',
    TELEGRAM_PAIRING_TTL_SECONDS,
  );
  await redis.set(
    `${PAIRING_USERNAME_PREFIX}${input.suggestedUsername}`,
    pairingId,
    'EX',
    TELEGRAM_PAIRING_TTL_SECONDS,
  );

  return { record, pollToken };
}

export async function getPairingRecord(
  pairingId: string,
): Promise<TelegramPairingRecord | null> {
  const raw = await getRedis().get(`${PAIRING_ID_PREFIX}${pairingId}`);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as TelegramPairingRecord;
  } catch {
    return null;
  }
}

export async function findPairingIdByUsername(
  suggestedUsername: string,
): Promise<string | null> {
  return getRedis().get(`${PAIRING_USERNAME_PREFIX}${suggestedUsername}`);
}

export async function markPairingReady(input: {
  pairingId: string;
  token: string;
  botUsername: string | null;
  ownerTelegramUserId: string;
  ownerTelegramUsername: string | null;
}): Promise<void> {
  const record = await getPairingRecord(input.pairingId);
  if (!record || record.status === 'ready') {
    return;
  }

  const next: TelegramPairingRecord = {
    ...record,
    status: 'ready',
    token: input.token,
    ...(input.botUsername ? { botUsername: input.botUsername } : {}),
    ownerTelegramUserId: input.ownerTelegramUserId,
    ...(input.ownerTelegramUsername
      ? { ownerTelegramUsername: input.ownerTelegramUsername }
      : {}),
  };

  // Refresh the TTL so the client's poll loop has the full window to pick
  // the token up even when the user took a while to confirm in Telegram.
  await getRedis().set(
    `${PAIRING_ID_PREFIX}${input.pairingId}`,
    JSON.stringify(next),
    'EX',
    TELEGRAM_PAIRING_TTL_SECONDS,
  );
}

/** Delete a pairing after its token was handed out (one-shot retrieval). */
export async function deletePairingRecord(
  record: TelegramPairingRecord,
): Promise<void> {
  const redis = getRedis();
  await redis.del(`${PAIRING_ID_PREFIX}${record.pairingId}`);
  await redis.del(`${PAIRING_USERNAME_PREFIX}${record.suggestedUsername}`);
}

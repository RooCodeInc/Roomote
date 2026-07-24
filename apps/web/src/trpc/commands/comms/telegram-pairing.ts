import { getRedis } from '@roomote/redis';
import { isValidTelegramBotToken } from '@roomote/communication/telegram-managed-bot';

import { Env } from '@/lib/server/env';
import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../environment-variables';
import { saveCommsAuthConfigCommand } from './index';
import { setTelegramBotProfilePhotoBestEffort } from './telegram-profile-photo';

/**
 * Client half of Telegram managed-bot pairing: talks to the pairing service
 * at `R_TELEGRAM_PAIRING_URL` (Roomote's hosted instance by default, or a
 * self-hosted one). The secret poll token stays server-side in Redis so the
 * bot token never passes through the admin's browser; when the pairing
 * completes we feed the token straight into the regular Telegram save path,
 * which persists it, generates the webhook secret, and registers the
 * webhook.
 */

const PAIRING_SERVICE_PATH = '/api/webhooks/telegram-pairing';
const CLIENT_PAIRING_KEY_PREFIX = 'telegram-pairing-client:';
const CLIENT_PAIRING_RESULT_KEY_PREFIX = 'telegram-pairing-result:';
const PAIRING_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PAIRING_TTL_SECONDS = 15 * 60;

function getPairingServiceBaseUrl(): string {
  const base = Env.R_TELEGRAM_PAIRING_URL;
  if (!base) {
    throw new Error(
      'Automatic Telegram setup is not configured for this deployment.',
    );
  }
  return new URL(PAIRING_SERVICE_PATH, base).toString();
}

type TelegramPairingStartResult = {
  pairingId: string;
  deepLink: string;
  suggestedUsername: string;
  expiresInSeconds: number;
};

export async function startTelegramPairingCommand(
  auth: UserAuthSuccess,
): Promise<TelegramPairingStartResult> {
  assertAdmin(auth);

  const response = await fetch(getPairingServiceBaseUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botName: 'Roomote' }),
    signal: AbortSignal.timeout(PAIRING_REQUEST_TIMEOUT_MS),
  }).catch(() => null);

  const payload = response?.ok
    ? ((await response.json().catch(() => null)) as {
        pairingId?: unknown;
        pollToken?: unknown;
        suggestedUsername?: unknown;
        deepLink?: unknown;
        expiresInSeconds?: unknown;
      } | null)
    : null;

  if (
    !payload ||
    typeof payload.pairingId !== 'string' ||
    typeof payload.pollToken !== 'string' ||
    typeof payload.suggestedUsername !== 'string' ||
    typeof payload.deepLink !== 'string'
  ) {
    throw new Error(
      'Could not reach the Telegram setup service. Try again, or enter a bot token manually.',
    );
  }

  const expiresInSeconds =
    typeof payload.expiresInSeconds === 'number' &&
    Number.isSafeInteger(payload.expiresInSeconds) &&
    payload.expiresInSeconds > 0
      ? payload.expiresInSeconds
      : DEFAULT_PAIRING_TTL_SECONDS;

  await getRedis().set(
    `${CLIENT_PAIRING_KEY_PREFIX}${payload.pairingId}`,
    payload.pollToken,
    'EX',
    expiresInSeconds,
  );

  return {
    pairingId: payload.pairingId,
    deepLink: payload.deepLink,
    suggestedUsername: payload.suggestedUsername,
    expiresInSeconds,
  };
}

type TelegramPairingCheckResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'ready';
      botUsername: string | null;
      telegramWebhook: { registered: boolean; error: string | null } | null;
      telegramProfilePhoto: { updated: boolean; error: string | null };
    };

type StashedPairingResult = {
  token: string;
  botUsername: string | null;
};

/**
 * Retrieve the pairing result, tolerating retries. The service hands the
 * token out exactly once, so the result is stashed in Redis the moment it
 * arrives — if persisting the configuration fails afterwards, the next poll
 * recovers the token from the stash instead of finding a consumed pairing.
 */
async function fetchPairingResult(
  pairingId: string,
): Promise<
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'ready'; result: StashedPairingResult }
> {
  const redis = getRedis();
  const pollTokenKey = `${CLIENT_PAIRING_KEY_PREFIX}${pairingId}`;
  const resultKey = `${CLIENT_PAIRING_RESULT_KEY_PREFIX}${pairingId}`;

  const stashedRaw = await redis.get(resultKey);
  if (stashedRaw) {
    try {
      const stashed = JSON.parse(stashedRaw) as StashedPairingResult;
      if (isValidTelegramBotToken(stashed.token)) {
        return { status: 'ready', result: stashed };
      }
    } catch {
      // Fall through to the service poll.
    }
  }

  const pollToken = await redis.get(pollTokenKey);
  if (!pollToken) {
    return { status: 'expired' };
  }

  const response = await fetch(
    `${getPairingServiceBaseUrl()}/${encodeURIComponent(pairingId)}`,
    {
      headers: { Authorization: `Bearer ${pollToken}` },
      signal: AbortSignal.timeout(PAIRING_REQUEST_TIMEOUT_MS),
    },
  ).catch(() => null);

  if (!response) {
    return { status: 'pending' };
  }

  if (response.status === 404) {
    // The service forgot the pairing (expired or already consumed).
    await redis.del(pollTokenKey);
    return { status: 'expired' };
  }

  const payload = (await response.json().catch(() => null)) as {
    status?: unknown;
    token?: unknown;
    botUsername?: unknown;
  } | null;

  if (payload?.status !== 'ready') {
    return { status: 'pending' };
  }

  if (!isValidTelegramBotToken(payload.token)) {
    await redis.del(pollTokenKey);
    throw new Error(
      'The Telegram setup service returned an invalid bot token. Try again, or enter a bot token manually.',
    );
  }

  const result: StashedPairingResult = {
    token: payload.token,
    botUsername:
      typeof payload.botUsername === 'string' && payload.botUsername.length > 0
        ? payload.botUsername
        : null,
  };

  await redis.set(
    resultKey,
    JSON.stringify(result),
    'EX',
    DEFAULT_PAIRING_TTL_SECONDS,
  );

  return { status: 'ready', result };
}

export async function checkTelegramPairingCommand(
  auth: UserAuthSuccess,
  input: { pairingId: string },
): Promise<TelegramPairingCheckResult> {
  assertAdmin(auth);

  const fetched = await fetchPairingResult(input.pairingId);
  if (fetched.status !== 'ready') {
    return fetched;
  }

  // The shared save path also generates the webhook secret and registers the
  // webhook. If it throws, the stash above keeps the token recoverable and
  // the caller can simply poll again.
  const saved = await saveCommsAuthConfigCommand(auth, {
    provider: 'telegram',
    values: { R_TELEGRAM_BOT_TOKEN: fetched.result.token },
  });

  const telegramProfilePhoto = await setTelegramBotProfilePhotoBestEffort({
    botToken: fetched.result.token,
  });

  const redis = getRedis();
  await redis.del(`${CLIENT_PAIRING_RESULT_KEY_PREFIX}${input.pairingId}`);
  await redis.del(`${CLIENT_PAIRING_KEY_PREFIX}${input.pairingId}`);

  return {
    status: 'ready',
    botUsername: fetched.result.botUsername,
    telegramWebhook: saved.telegramWebhook ?? null,
    telegramProfilePhoto,
  };
}

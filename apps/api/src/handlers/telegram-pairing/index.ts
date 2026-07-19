import crypto from 'node:crypto';

import { Hono } from 'hono';

import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';
import {
  buildManagedBotDeepLink,
  generateManagedBotUsername,
  getManagedBotToken,
  parseTelegramManagedBotUpdate,
  registerManagerBotWebhook,
} from '@roomote/communication/telegram-managed-bot';

import { apiLogger } from '../../logging.js';
import {
  TELEGRAM_PAIRING_TTL_SECONDS,
  createPairingRecord,
  deletePairingRecord,
  findPairingIdByUsername,
  getPairingRecord,
  hashPollToken,
  markPairingReady,
} from './store.js';

/**
 * Telegram managed-bot pairing service (Bot API 9.6 Managed Bots).
 *
 * This service runs on any deployment that configures a manager bot
 * (`R_TELEGRAM_MANAGER_BOT_TOKEN` + `R_TELEGRAM_MANAGER_BOT_USERNAME` +
 * `R_TELEGRAM_MANAGER_WEBHOOK_SECRET`). Roomote hosts one central instance;
 * other deployments point `R_TELEGRAM_PAIRING_URL` at it and never need
 * these env vars. Flow:
 *
 *   1. `POST /api/telegram-pairing` mints a pairing: a high-entropy
 *      suggested bot username (the correlation key), a secret poll token,
 *      and a `t.me/newbot/<manager>/<username>` deep link.
 *   2. The admin opens the deep link and taps "Create Bot" in Telegram.
 *   3. Telegram sends the manager bot a `managed_bot` update; the webhook
 *      handler matches the username, exports the child bot's token via
 *      `getManagedBotToken`, and marks the pairing ready.
 *   4. The client deployment polls `GET /api/telegram-pairing/:id` with the
 *      poll token and receives the bot token exactly once.
 */

const MANAGER_WEBHOOK_PATH = '/api/webhooks/telegram-manager';
const MANAGER_WEBHOOK_REGISTERED_KEY = 'telegram-pairing:manager-webhook';
const MANAGER_WEBHOOK_RECHECK_SECONDS = 60 * 60;
const MAX_BOT_NAME_LENGTH = 64;
const DEFAULT_BOT_NAME = 'Roomote';

type ManagerBotConfig = {
  managerBotToken: string;
  managerBotUsername: string;
  webhookSecret: string;
};

function getManagerBotConfig(): ManagerBotConfig | null {
  const managerBotToken = Env.R_TELEGRAM_MANAGER_BOT_TOKEN;
  const managerBotUsername = Env.R_TELEGRAM_MANAGER_BOT_USERNAME;
  const webhookSecret = Env.R_TELEGRAM_MANAGER_WEBHOOK_SECRET;
  if (!managerBotToken || !managerBotUsername || !webhookSecret) {
    return null;
  }
  return { managerBotToken, managerBotUsername, webhookSecret };
}

/**
 * Keep the manager bot's webhook pointed at this deployment, re-checked at
 * most hourly. Best-effort: a Telegram outage must not block pairing
 * creation (the webhook is usually already registered).
 */
async function ensureManagerWebhookRegistered(
  config: ManagerBotConfig,
): Promise<void> {
  const redis = getRedis();
  const alreadyChecked = await redis.get(MANAGER_WEBHOOK_REGISTERED_KEY);
  if (alreadyChecked) {
    return;
  }

  try {
    await registerManagerBotWebhook({
      managerBotToken: config.managerBotToken,
      webhookUrl: new URL(MANAGER_WEBHOOK_PATH, Env.R_APP_URL).toString(),
      webhookSecret: config.webhookSecret,
    });
    await redis.set(
      MANAGER_WEBHOOK_REGISTERED_KEY,
      '1',
      'EX',
      MANAGER_WEBHOOK_RECHECK_SECONDS,
    );
  } catch (error) {
    apiLogger.warn(
      { err: error },
      'telegram-pairing: manager webhook registration failed',
    );
  }
}

function safeCompareSecret(expected: string, actual: string | null): boolean {
  if (!actual) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function readBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export const telegramPairing = new Hono();

telegramPairing.post('/', async (c) => {
  const config = getManagerBotConfig();
  if (!config) {
    return c.json({ error: 'Telegram pairing is not enabled here.' }, 404);
  }

  await ensureManagerWebhookRegistered(config);

  const body = (await c.req.json().catch(() => ({}))) as {
    botName?: unknown;
  };
  const botName =
    typeof body.botName === 'string' && body.botName.trim().length > 0
      ? body.botName.trim().slice(0, MAX_BOT_NAME_LENGTH)
      : DEFAULT_BOT_NAME;

  const suggestedUsername = generateManagedBotUsername();
  const { record, pollToken } = await createPairingRecord({
    suggestedUsername,
  });

  return c.json(
    {
      pairingId: record.pairingId,
      pollToken,
      suggestedUsername,
      deepLink: buildManagedBotDeepLink({
        managerBotUsername: config.managerBotUsername,
        suggestedUsername,
        botName,
      }),
      expiresInSeconds: TELEGRAM_PAIRING_TTL_SECONDS,
    },
    201,
  );
});

telegramPairing.get('/:pairingId', async (c) => {
  if (!getManagerBotConfig()) {
    return c.json({ error: 'Telegram pairing is not enabled here.' }, 404);
  }

  const pairingId = c.req.param('pairingId');
  const record = await getPairingRecord(pairingId);
  const pollToken = readBearerToken(c.req.header('authorization'));

  // A missing record and a bad token look identical to the caller so the
  // endpoint leaks nothing about which pairing ids exist.
  if (
    !record ||
    !pollToken ||
    !safeCompareSecret(record.pollTokenHash, hashPollToken(pollToken))
  ) {
    return c.json({ error: 'Unknown pairing.' }, 404);
  }

  if (record.status !== 'ready' || !record.token) {
    return c.json({ status: 'pending' });
  }

  // One-shot: the token is handed out exactly once, then forgotten.
  await deletePairingRecord(record);

  return c.json({
    status: 'ready',
    token: record.token,
    botUsername: record.botUsername ?? null,
    ownerTelegramUserId: record.ownerTelegramUserId ?? null,
    ownerTelegramUsername: record.ownerTelegramUsername ?? null,
  });
});

export const telegramManagerWebhook = new Hono();

telegramManagerWebhook.post('/', async (c) => {
  const config = getManagerBotConfig();
  if (!config) {
    return c.json({ error: 'Telegram pairing is not enabled here.' }, 404);
  }

  if (
    !safeCompareSecret(
      config.webhookSecret,
      c.req.header('x-telegram-bot-api-secret-token') ?? null,
    )
  ) {
    return c.json({ error: 'Invalid webhook secret.' }, 401);
  }

  const update = await c.req.json().catch(() => null);
  const managedBot = parseTelegramManagedBotUpdate(update);
  if (!managedBot) {
    // Not a managed_bot update; acknowledge so Telegram does not retry.
    return c.json({ ok: true });
  }

  const pairingId = managedBot.botUsername
    ? await findPairingIdByUsername(managedBot.botUsername)
    : null;
  if (!pairingId) {
    apiLogger.warn(
      { botUsername: managedBot.botUsername },
      'telegram-pairing: managed_bot update without a matching pairing',
    );
    return c.json({ ok: true });
  }

  try {
    const token = await getManagedBotToken({
      managerBotToken: config.managerBotToken,
      botUserId: managedBot.botUserId,
    });
    await markPairingReady({
      pairingId,
      token,
      botUsername: managedBot.botUsername,
      ownerTelegramUserId: managedBot.ownerTelegramUserId,
      ownerTelegramUsername: managedBot.ownerTelegramUsername,
    });
  } catch (error) {
    // Leave the pairing pending; Telegram retries the update delivery, so a
    // transient getManagedBotToken failure heals on the next attempt.
    apiLogger.error(
      { err: error, pairingId },
      'telegram-pairing: failed to fetch managed bot token',
    );
    return c.json({ error: 'Failed to fetch managed bot token.' }, 500);
  }

  return c.json({ ok: true });
});

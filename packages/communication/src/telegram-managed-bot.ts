import { randomInt } from 'node:crypto';

import { getTelegramApiBaseUrl } from './telegram-api-base-url';

/**
 * Helpers for Telegram's Managed Bots feature (Bot API 9.6): a "manager bot"
 * with Bot Management Mode enabled can receive `managed_bot` updates when a
 * user confirms creation via a `t.me/newbot/<manager>/<username>` deep link,
 * then fetch the child bot's token with `getManagedBotToken`. Roomote uses
 * this to create a deployment's bot without manual BotFather token
 * copy-paste.
 */

// Telegram bot usernames allow letters, digits, and underscores. The slug is
// the only correlation key between the deep link we hand out and the
// `managed_bot` update we later receive, so it has to be unguessable:
// 16 chars from a 32-symbol alphabet gives 80 bits of entropy while keeping
// `roomote_<slug>_bot` within Telegram's 32-character username limit.
const USERNAME_SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const USERNAME_SLUG_LENGTH = 16;

const MANAGED_BOT_USERNAME_PREFIX = 'roomote_';
const MANAGED_BOT_USERNAME_SUFFIX = '_bot';

const TELEGRAM_BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

const MANAGED_BOT_API_TIMEOUT_MS = 10_000;

export function generateManagedBotUsername(): string {
  let slug = '';
  for (let index = 0; index < USERNAME_SLUG_LENGTH; index += 1) {
    slug += USERNAME_SLUG_ALPHABET[randomInt(USERNAME_SLUG_ALPHABET.length)];
  }
  return `${MANAGED_BOT_USERNAME_PREFIX}${slug}${MANAGED_BOT_USERNAME_SUFFIX}`;
}

export function isManagedBotUsername(value: string): boolean {
  return (
    value.startsWith(MANAGED_BOT_USERNAME_PREFIX) &&
    value.endsWith(MANAGED_BOT_USERNAME_SUFFIX) &&
    value.length <= 32
  );
}

export function isValidTelegramBotToken(value: unknown): value is string {
  return typeof value === 'string' && TELEGRAM_BOT_TOKEN_RE.test(value);
}

export function buildManagedBotDeepLink(input: {
  managerBotUsername: string;
  suggestedUsername: string;
  botName?: string;
}): string {
  const manager = input.managerBotUsername.replace(/^@/, '');
  const base = `https://t.me/newbot/${encodeURIComponent(manager)}/${encodeURIComponent(input.suggestedUsername)}`;
  if (!input.botName) {
    return base;
  }
  return `${base}?${new URLSearchParams({ name: input.botName }).toString()}`;
}

export type TelegramManagedBotUpdate = {
  /** Telegram user id of the person who created (owns) the bot. */
  ownerTelegramUserId: string;
  ownerTelegramUsername: string | null;
  /** Telegram user id of the newly created bot. */
  botUserId: string;
  botUsername: string | null;
};

/**
 * Extract the `managed_bot` payload from a raw webhook update body. Returns
 * null for every other update type so callers can cheaply ignore them.
 */
export function parseTelegramManagedBotUpdate(
  update: unknown,
): TelegramManagedBotUpdate | null {
  if (typeof update !== 'object' || update === null) {
    return null;
  }

  const managedBot = (update as { managed_bot?: unknown }).managed_bot;
  if (typeof managedBot !== 'object' || managedBot === null) {
    return null;
  }

  const { user, bot } = managedBot as { user?: unknown; bot?: unknown };
  const ownerId = readTelegramUserId(user);
  const botId = readTelegramUserId(bot);
  if (!ownerId || !botId) {
    return null;
  }

  return {
    ownerTelegramUserId: ownerId,
    ownerTelegramUsername: readTelegramUsername(user),
    botUserId: botId,
    botUsername: readTelegramUsername(bot),
  };
}

function readTelegramUserId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
    return String(id);
  }
  if (typeof id === 'string' && /^\d+$/.test(id)) {
    return id;
  }
  return null;
}

function readTelegramUsername(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const username = (value as { username?: unknown }).username;
  return typeof username === 'string' && username.length > 0 ? username : null;
}

async function callManagerBotApi(input: {
  managerBotToken: string;
  method: string;
  body: Record<string, unknown>;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${input.apiBaseUrl ?? getTelegramApiBaseUrl()}/bot${input.managerBotToken}/${input.method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(MANAGED_BOT_API_TIMEOUT_MS),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  } | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(
      `Telegram ${input.method} failed (${response.status}): ${payload?.description ?? 'unknown error'}`,
    );
  }

  return payload.result;
}

/** Fetch a managed child bot's token via the manager bot. */
export async function getManagedBotToken(input: {
  managerBotToken: string;
  botUserId: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const result = await callManagerBotApi({
    managerBotToken: input.managerBotToken,
    method: 'getManagedBotToken',
    body: { bot_user_id: Number(input.botUserId) },
    apiBaseUrl: input.apiBaseUrl,
    fetchImpl: input.fetchImpl,
  });

  const token =
    typeof result === 'string'
      ? result
      : typeof result === 'object' && result !== null
        ? (result as { token?: unknown }).token
        : null;

  if (!isValidTelegramBotToken(token)) {
    throw new Error(
      'Telegram getManagedBotToken returned an unrecognized token shape.',
    );
  }

  return token;
}

/**
 * Point the manager bot's webhook at the pairing service so `managed_bot`
 * updates arrive there. Idempotent; callers may re-run it best-effort.
 */
export async function registerManagerBotWebhook(input: {
  managerBotToken: string;
  webhookUrl: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await callManagerBotApi({
    managerBotToken: input.managerBotToken,
    method: 'setWebhook',
    body: {
      url: input.webhookUrl,
      secret_token: input.webhookSecret,
      allowed_updates: ['managed_bot'],
    },
    apiBaseUrl: input.apiBaseUrl,
    fetchImpl: input.fetchImpl,
  });
}

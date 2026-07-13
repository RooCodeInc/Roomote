import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db';
import { deploymentSettings } from '../schema';
import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';

export type TelegramRuntimeCredentials = {
  botToken: string | null;
  webhookSecret: string | null;
  botUsername: string | null;
};

const CACHE_TTL_MS = 30_000;
const BOT_INFO_TTL_MS = 24 * 60 * 60 * 1000;
const BOT_INFO_METADATA_KEY = 'telegram_bot_info_cache';

let cachedCredentials: {
  value: TelegramRuntimeCredentials;
  expiresAtMs: number;
} | null = null;

/** BotFather tokens never contain whitespace; strip paste newlines/spaces. */
export function normalizeTelegramBotToken(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.replace(/\s+/g, '');
  return normalized.length > 0 ? normalized : null;
}

function readProcessEnvCredentials(): Omit<
  TelegramRuntimeCredentials,
  'botUsername'
> {
  return {
    botToken: normalizeTelegramBotToken(process.env.R_TELEGRAM_BOT_TOKEN),
    webhookSecret: process.env.R_TELEGRAM_WEBHOOK_SECRET?.trim() || null,
  };
}

async function resolveTelegramBotUsername(
  botToken: string | null,
): Promise<string | null> {
  if (!botToken) return null;

  const tokenFingerprint = createHash('sha256').update(botToken).digest('hex');
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
    columns: { metadata: true },
  });
  const cached = (settings?.metadata as Record<string, unknown> | undefined)?.[
    BOT_INFO_METADATA_KEY
  ] as
    | { tokenFingerprint?: string; username?: string; fetchedAtMs?: number }
    | undefined;
  const matchingCachedUsername =
    cached?.tokenFingerprint === tokenFingerprint && cached.username
      ? cached.username
      : null;
  if (
    matchingCachedUsername &&
    typeof cached?.fetchedAtMs === 'number' &&
    Date.now() - cached.fetchedAtMs < BOT_INFO_TTL_MS
  ) {
    return matchingCachedUsername;
  }

  try {
    const apiBaseUrl =
      process.env.R_TELEGRAM_API_BASE_URL?.replace(/\/$/u, '') ??
      'https://api.telegram.org';
    const response = await fetch(`${apiBaseUrl}/bot${botToken}/getMe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { username?: string };
    } | null;
    const username = body?.result?.username?.trim().replace(/^@/u, '');

    if (!response.ok || !body?.ok || !username) {
      return matchingCachedUsername;
    }

    try {
      await db
        .update(deploymentSettings)
        .set({
          metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({
            [BOT_INFO_METADATA_KEY]: {
              tokenFingerprint,
              username,
              fetchedAtMs: Date.now(),
            },
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(deploymentSettings.id, 'default'));
    } catch {
      // Identity lookup still succeeded; persistence is only an optimization.
    }

    return username;
  } catch {
    return matchingCachedUsername;
  }
}

/**
 * Resolve the Telegram bot credentials the way operators configure them:
 * real environment variables always win, and values saved from the comms
 * settings UI (encrypted deployment env vars) fill any gaps. Resolved values
 * are cached briefly so webhook-path callers do not hit the database on
 * every update.
 */
export async function resolveTelegramRuntimeCredentials(): Promise<TelegramRuntimeCredentials> {
  const fromEnv = readProcessEnvCredentials();

  const nowMs = Date.now();

  if (cachedCredentials && cachedCredentials.expiresAtMs > nowMs) {
    return cachedCredentials.value;
  }

  const deploymentEnvVars =
    fromEnv.botToken && fromEnv.webhookSecret
      ? {}
      : await resolveEffectiveDeploymentEnvVars();
  const botToken =
    fromEnv.botToken ||
    normalizeTelegramBotToken(deploymentEnvVars.R_TELEGRAM_BOT_TOKEN);
  const lastKnownBotUsername =
    cachedCredentials?.value.botToken === botToken
      ? cachedCredentials.value.botUsername
      : null;
  const value: TelegramRuntimeCredentials = {
    botToken,
    webhookSecret:
      fromEnv.webhookSecret ||
      deploymentEnvVars.R_TELEGRAM_WEBHOOK_SECRET?.trim() ||
      null,
    botUsername:
      (await resolveTelegramBotUsername(botToken)) ?? lastKnownBotUsername,
  };

  cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };

  return value;
}

/** Drop the cached credentials, e.g. right after the settings UI saves. */
export function invalidateTelegramRuntimeCredentialsCache(): void {
  cachedCredentials = null;
}

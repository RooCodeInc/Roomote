import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';

export type TelegramRuntimeCredentials = {
  botToken: string | null;
  webhookSecret: string | null;
  botUsername: string | null;
};

const CACHE_TTL_MS = 30_000;

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

function normalizeTelegramBotUsername(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().replace(/^@/, '');
  return normalized.length > 0 ? normalized : null;
}

function readProcessEnvCredentials(): TelegramRuntimeCredentials {
  return {
    botToken: normalizeTelegramBotToken(process.env.R_TELEGRAM_BOT_TOKEN),
    webhookSecret: process.env.R_TELEGRAM_WEBHOOK_SECRET?.trim() || null,
    botUsername: normalizeTelegramBotUsername(
      process.env.R_TELEGRAM_BOT_USERNAME,
    ),
  };
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

  if (fromEnv.botToken && fromEnv.webhookSecret && fromEnv.botUsername) {
    return fromEnv;
  }

  const nowMs = Date.now();

  if (cachedCredentials && cachedCredentials.expiresAtMs > nowMs) {
    return cachedCredentials.value;
  }

  const deploymentEnvVars = await resolveEffectiveDeploymentEnvVars();
  const value: TelegramRuntimeCredentials = {
    botToken:
      fromEnv.botToken ||
      normalizeTelegramBotToken(deploymentEnvVars.R_TELEGRAM_BOT_TOKEN),
    webhookSecret:
      fromEnv.webhookSecret ||
      deploymentEnvVars.R_TELEGRAM_WEBHOOK_SECRET?.trim() ||
      null,
    botUsername:
      fromEnv.botUsername ||
      normalizeTelegramBotUsername(deploymentEnvVars.R_TELEGRAM_BOT_USERNAME),
  };

  cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };

  return value;
}

/** Drop the cached credentials, e.g. right after the settings UI saves. */
export function invalidateTelegramRuntimeCredentialsCache(): void {
  cachedCredentials = null;
}

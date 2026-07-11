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

function readProcessEnvCredentials(): TelegramRuntimeCredentials {
  return {
    botToken: process.env.R_TELEGRAM_BOT_TOKEN?.trim() || null,
    webhookSecret: process.env.R_TELEGRAM_WEBHOOK_SECRET?.trim() || null,
    botUsername: process.env.R_TELEGRAM_BOT_USERNAME?.trim() || null,
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
      deploymentEnvVars.R_TELEGRAM_BOT_TOKEN?.trim() ||
      null,
    webhookSecret:
      fromEnv.webhookSecret ||
      deploymentEnvVars.R_TELEGRAM_WEBHOOK_SECRET?.trim() ||
      null,
    botUsername:
      fromEnv.botUsername ||
      deploymentEnvVars.R_TELEGRAM_BOT_USERNAME?.trim() ||
      null,
  };

  cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };

  return value;
}

/** Drop the cached credentials, e.g. right after the settings UI saves. */
export function invalidateTelegramRuntimeCredentialsCache(): void {
  cachedCredentials = null;
}

import { Env } from '@roomote/env';

const DEFAULT_TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

/**
 * Resolves the Telegram Bot API host, mirroring `getSlackApiBaseUrl` in
 * `@roomote/slack`: `R_TELEGRAM_API_BASE_URL` lets tests and the mock Telegram
 * harness reroute every outbound Bot API call without touching call sites.
 */
export function getTelegramApiBaseUrl(): string {
  const configuredUrl = (
    process.env.R_TELEGRAM_API_BASE_URL ??
    Env.R_TELEGRAM_API_BASE_URL ??
    DEFAULT_TELEGRAM_API_BASE_URL
  ).trim();

  return configuredUrl.replace(/\/+$/, '');
}

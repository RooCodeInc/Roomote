const DEFAULT_PORT = 3003;
const DEFAULT_API_TIMEOUT_MS = 10_000;
const DEFAULT_DELIVERY_MAX_ATTEMPTS = 8;
const DEFAULT_DELIVERY_MAX_BACKOFF_MS = 30_000;
const DEFAULT_LOGIN_RETRY_BASE_MS = 15_000;
const DEFAULT_LOGIN_RETRY_MAX_MS = 5 * 60_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

export type DiscordGatewayConfig = {
  port: number;
  apiEventsUrl: string;
  /** Snapshot used for secret/credential env resolution when embedded. */
  processEnv: NodeJS.ProcessEnv;
  apiTimeoutMs: number;
  leaderLeaseTtlSeconds: number;
  leaderLeaseRenewMs: number;
  statusTtlSeconds: number;
  statusRefreshMs: number;
  credentialPollMs: number;
  standbyPollMs: number;
  deliveryPollMs: number;
  deliveryMaxAttempts: number;
  deliveryMaxBackoffMs: number;
  loginRetryBaseMs: number;
  loginRetryMaxMs: number;
};

export function resolveDiscordGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscordGatewayConfig {
  const apiBaseUrl = env.TRPC_URL?.trim() || 'http://127.0.0.1:13001';

  return {
    port: positiveInteger(env.PORT, DEFAULT_PORT),
    apiEventsUrl: `${withoutTrailingSlashes(apiBaseUrl)}/api/internal/discord/events`,
    processEnv: env,
    apiTimeoutMs: positiveInteger(
      env.DISCORD_GATEWAY_API_TIMEOUT_MS,
      DEFAULT_API_TIMEOUT_MS,
    ),
    leaderLeaseTtlSeconds: 30,
    leaderLeaseRenewMs: 10_000,
    statusTtlSeconds: 30,
    statusRefreshMs: 10_000,
    credentialPollMs: 15_000,
    standbyPollMs: 5_000,
    deliveryPollMs: 500,
    deliveryMaxAttempts: positiveInteger(
      env.DISCORD_GATEWAY_DELIVERY_MAX_ATTEMPTS,
      DEFAULT_DELIVERY_MAX_ATTEMPTS,
    ),
    deliveryMaxBackoffMs: positiveInteger(
      env.DISCORD_GATEWAY_DELIVERY_MAX_BACKOFF_MS,
      DEFAULT_DELIVERY_MAX_BACKOFF_MS,
    ),
    loginRetryBaseMs: positiveInteger(
      env.DISCORD_GATEWAY_LOGIN_RETRY_BASE_MS,
      DEFAULT_LOGIN_RETRY_BASE_MS,
    ),
    loginRetryMaxMs: positiveInteger(
      env.DISCORD_GATEWAY_LOGIN_RETRY_MAX_MS,
      DEFAULT_LOGIN_RETRY_MAX_MS,
    ),
  };
}

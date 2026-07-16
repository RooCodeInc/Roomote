import { createHash } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { db } from '../db';
import { deploymentSettings } from '../schema';
import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';

export type DiscordBotIdentity = {
  applicationId: string;
  applicationName: string | null;
  botUserId: string;
  botUsername: string;
  botDisplayName: string;
};

export type DiscordBotIdentitySource = 'live' | 'persistent_cache' | null;

export type DiscordRuntimeCredentials = {
  botToken: string | null;
  applicationId: string | null;
  applicationName: string | null;
  botUserId: string | null;
  botUsername: string | null;
  botDisplayName: string | null;
  identitySource: DiscordBotIdentitySource;
  identityErrorCode: DiscordBotTokenValidationErrorCode | null;
};

export type DiscordBotTokenValidationErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'identity_mismatch';

export class DiscordBotTokenValidationError extends Error {
  readonly code: DiscordBotTokenValidationErrorCode;
  readonly retryAfterMs: number | null;

  constructor(
    code: DiscordBotTokenValidationErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number | null },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'DiscordBotTokenValidationError';
    this.code = code;
    this.retryAfterMs = options?.retryAfterMs ?? null;
  }
}

const CACHE_TTL_MS = 30_000;
const BOT_INFO_TTL_MS = 24 * 60 * 60 * 1000;
const BOT_INFO_METADATA_KEY = 'discord_bot_info_cache';
const DISCORD_API_TIMEOUT_MS = 10_000;

type PersistedDiscordBotInfo = {
  tokenFingerprint?: string;
  identity?: DiscordBotIdentity;
  fetchedAtMs?: number;
};

let cachedCredentials: {
  value: DiscordRuntimeCredentials;
  expiresAtMs: number;
} | null = null;

let gatewaySecretCache: {
  value: string | null;
  expiresAtMs: number;
} | null = null;

/**
 * Accept a raw token or the value copied from an Authorization header. Discord
 * bot tokens contain no whitespace, so paste-introduced whitespace is safe to
 * remove after stripping an optional `Bot` prefix.
 */
export function normalizeDiscordBotToken(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .trim()
    .replace(/^Bot\s+/iu, '')
    .replace(/\s+/gu, '');
  return normalized.length > 0 ? normalized : null;
}

function discordApiBaseUrl(): string {
  return (
    process.env.DISCORD_API_BASE_URL?.replace(/\/$/u, '') ??
    'https://discord.com/api/v10'
  );
}

async function readDiscordJson(
  botToken: string,
  path: string,
): Promise<{ response: Response; body: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetch(`${discordApiBaseUrl()}${path}`, {
      headers: { authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DiscordBotTokenValidationError(
      'unavailable',
      'Discord could not be reached while validating the bot token.',
      { cause: error },
    );
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (response.status === 401 || response.status === 403) {
    throw new DiscordBotTokenValidationError(
      'unauthorized',
      'Discord rejected the configured bot token.',
    );
  }

  if (response.status === 429) {
    const retryAfterSeconds =
      typeof body?.retry_after === 'number' ? body.retry_after : null;
    throw new DiscordBotTokenValidationError(
      'rate_limited',
      'Discord rate-limited bot identity validation.',
      {
        retryAfterMs:
          retryAfterSeconds === null
            ? null
            : Math.max(0, retryAfterSeconds * 1000),
      },
    );
  }

  if (!response.ok) {
    throw new DiscordBotTokenValidationError(
      'unavailable',
      `Discord bot identity validation failed with HTTP ${response.status}.`,
    );
  }

  if (!body) {
    throw new DiscordBotTokenValidationError(
      'invalid_response',
      'Discord returned an invalid bot identity response.',
    );
  }

  return { response, body };
}

/**
 * Validate a token against both Discord identities Roomote relies on. The
 * current-user endpoint proves this is a bot token; the current-application
 * endpoint provides the application id used for commands and installation
 * URLs. A mismatch is rejected rather than silently combining two identities.
 */
export async function validateDiscordBotToken(
  rawBotToken: string,
): Promise<DiscordBotIdentity> {
  const botToken = normalizeDiscordBotToken(rawBotToken);
  if (!botToken) {
    throw new DiscordBotTokenValidationError(
      'unauthorized',
      'A Discord bot token is required.',
    );
  }

  const [botResult, applicationResult] = await Promise.all([
    readDiscordJson(botToken, '/users/@me'),
    readDiscordJson(botToken, '/oauth2/applications/@me'),
  ]);
  const bot = botResult.body;
  const application = applicationResult.body;
  const applicationBot =
    application?.bot && typeof application.bot === 'object'
      ? (application.bot as Record<string, unknown>)
      : null;

  const botUserId = typeof bot?.id === 'string' ? bot.id : '';
  const botUsername = typeof bot?.username === 'string' ? bot.username : '';
  const applicationId =
    typeof application?.id === 'string' ? application.id : '';
  const applicationBotUserId =
    typeof applicationBot?.id === 'string' ? applicationBot.id : null;

  if (!botUserId || !botUsername || !applicationId || bot?.bot !== true) {
    throw new DiscordBotTokenValidationError(
      'invalid_response',
      'Discord did not return a complete bot and application identity.',
    );
  }

  if (applicationBotUserId && applicationBotUserId !== botUserId) {
    throw new DiscordBotTokenValidationError(
      'identity_mismatch',
      'The Discord application and bot identities do not match.',
    );
  }

  const globalName =
    typeof bot.global_name === 'string' && bot.global_name.trim()
      ? bot.global_name.trim()
      : null;

  return {
    applicationId,
    applicationName:
      typeof application?.name === 'string' && application.name.trim()
        ? application.name.trim()
        : null,
    botUserId,
    botUsername,
    botDisplayName: globalName ?? botUsername,
  };
}

async function readPersistedIdentity(
  tokenFingerprint: string,
): Promise<{ identity: DiscordBotIdentity; fetchedAtMs: number } | null> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
    columns: { metadata: true },
  });
  const cached = (settings?.metadata as Record<string, unknown> | undefined)?.[
    BOT_INFO_METADATA_KEY
  ] as PersistedDiscordBotInfo | undefined;

  const identity = cached?.identity;
  if (
    cached?.tokenFingerprint !== tokenFingerprint ||
    !identity ||
    typeof cached.fetchedAtMs !== 'number' ||
    typeof identity.applicationId !== 'string' ||
    !identity.applicationId ||
    (identity.applicationName !== null &&
      typeof identity.applicationName !== 'string') ||
    typeof identity.botUserId !== 'string' ||
    !identity.botUserId ||
    typeof identity.botUsername !== 'string' ||
    !identity.botUsername ||
    typeof identity.botDisplayName !== 'string' ||
    !identity.botDisplayName
  ) {
    return null;
  }

  return { identity, fetchedAtMs: cached.fetchedAtMs };
}

async function persistIdentity(
  tokenFingerprint: string,
  identity: DiscordBotIdentity,
): Promise<void> {
  try {
    await db
      .update(deploymentSettings)
      .set({
        metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({
          [BOT_INFO_METADATA_KEY]: {
            tokenFingerprint,
            identity,
            fetchedAtMs: Date.now(),
          },
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));
  } catch {
    // Validation succeeded. Persistence is a restart optimization only.
  }
}

function credentialsFromIdentity(input: {
  botToken: string;
  identity: DiscordBotIdentity;
  identitySource: Exclude<DiscordBotIdentitySource, null>;
  identityErrorCode?: DiscordBotTokenValidationErrorCode | null;
}): DiscordRuntimeCredentials {
  return {
    botToken: input.botToken,
    ...input.identity,
    identitySource: input.identitySource,
    identityErrorCode: input.identityErrorCode ?? null,
  };
}

/**
 * Resolve the deployment-owned Discord token and its validated identity.
 * Process environment configuration wins over encrypted settings. Identity is
 * persisted by token fingerprint so restarts and transient Discord outages do
 * not erase the application id needed by the Gateway and command registrar.
 */
export async function resolveDiscordRuntimeCredentials(): Promise<DiscordRuntimeCredentials> {
  const nowMs = Date.now();
  if (cachedCredentials && cachedCredentials.expiresAtMs > nowMs) {
    return cachedCredentials.value;
  }

  const fromProcess = normalizeDiscordBotToken(process.env.R_DISCORD_BOT_TOKEN);
  const deploymentEnvVars = fromProcess
    ? {}
    : await resolveEffectiveDeploymentEnvVars();
  const botToken =
    fromProcess ??
    normalizeDiscordBotToken(deploymentEnvVars.R_DISCORD_BOT_TOKEN);

  if (!botToken) {
    const value: DiscordRuntimeCredentials = {
      botToken: null,
      applicationId: null,
      applicationName: null,
      botUserId: null,
      botUsername: null,
      botDisplayName: null,
      identitySource: null,
      identityErrorCode: null,
    };
    cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };
    return value;
  }

  const tokenFingerprint = createHash('sha256').update(botToken).digest('hex');
  const persisted = await readPersistedIdentity(tokenFingerprint);
  if (
    persisted &&
    nowMs - persisted.fetchedAtMs >= 0 &&
    nowMs - persisted.fetchedAtMs < BOT_INFO_TTL_MS
  ) {
    const value = credentialsFromIdentity({
      botToken,
      identity: persisted.identity,
      identitySource: 'persistent_cache',
    });
    cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };
    return value;
  }

  try {
    const identity = await validateDiscordBotToken(botToken);
    await persistIdentity(tokenFingerprint, identity);
    const value = credentialsFromIdentity({
      botToken,
      identity,
      identitySource: 'live',
    });
    cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };
    return value;
  } catch (error) {
    const errorCode =
      error instanceof DiscordBotTokenValidationError
        ? error.code
        : 'unavailable';
    const lastKnown =
      persisted?.identity ??
      (cachedCredentials?.value.botToken === botToken &&
      cachedCredentials.value.applicationId &&
      cachedCredentials.value.botUserId &&
      cachedCredentials.value.botUsername &&
      cachedCredentials.value.botDisplayName
        ? {
            applicationId: cachedCredentials.value.applicationId,
            applicationName: cachedCredentials.value.applicationName,
            botUserId: cachedCredentials.value.botUserId,
            botUsername: cachedCredentials.value.botUsername,
            botDisplayName: cachedCredentials.value.botDisplayName,
          }
        : null);
    const value = lastKnown
      ? credentialsFromIdentity({
          botToken,
          identity: lastKnown,
          identitySource: 'persistent_cache',
          identityErrorCode: errorCode,
        })
      : ({
          botToken,
          applicationId: null,
          applicationName: null,
          botUserId: null,
          botUsername: null,
          botDisplayName: null,
          identitySource: null,
          identityErrorCode: errorCode,
        } satisfies DiscordRuntimeCredentials);
    cachedCredentials = { value, expiresAtMs: nowMs + CACHE_TTL_MS };
    return value;
  }
}

/** Drop the process cache after settings changes or an explicit repair. */
export function invalidateDiscordRuntimeCredentialsCache(): void {
  cachedCredentials = null;
  gatewaySecretCache = null;
}

/**
 * Resolve the Discord gateway↔API transport secret. Process env wins over the
 * encrypted deployment vault (same source order as the bot token).
 */
export async function resolveDiscordGatewaySecret(): Promise<string | null> {
  const nowMs = Date.now();
  if (gatewaySecretCache && gatewaySecretCache.expiresAtMs > nowMs) {
    return gatewaySecretCache.value;
  }

  const fromEnv = process.env.R_DISCORD_GATEWAY_SECRET?.trim() || null;
  if (fromEnv) {
    gatewaySecretCache = { value: fromEnv, expiresAtMs: nowMs + CACHE_TTL_MS };
    return fromEnv;
  }

  const deploymentEnvVars = await resolveEffectiveDeploymentEnvVars();
  const value = deploymentEnvVars.R_DISCORD_GATEWAY_SECRET?.trim() || null;
  gatewaySecretCache = { value, expiresAtMs: nowMs + CACHE_TTL_MS };
  return value;
}

import { Redis } from 'ioredis';

import { Env } from '@roomote/env';

export type { Redis } from 'ioredis';

export const REDIS_KEYS = {
  MENTIONED_THREADS: 'slack:mentioned_threads',
  PENDING_WORKSPACE_SELECTIONS: 'slack:pending_workspace_selections',
  SLACK_AUTO_START_CHANNEL: 'slack:auto-start-channel',
  DISCORD_AUTO_START_CHANNEL: 'discord:auto-start-channel',
  CONTROLLER_HEARTBEAT: 'controller:heartbeat',
  /** Cached GitHub release notes payload keyed as `${prefix}:${version}`. */
  RELEASE_NOTES: 'release:notes',
  /**
   * Cached Slack `conversations.info` projection keyed as
   * `${prefix}:${scope}:${channelId}`.
   */
  SLACK_CHANNEL_INFO: 'slack:channel_info',
} as const;

/** Positive-cache TTL for successfully fetched GitHub release notes. */
export const RELEASE_NOTES_CACHE_TTL_SECONDS = 6 * 60 * 60;
/** Negative-cache TTL when a release is missing or GitHub fetch fails. */
export const RELEASE_NOTES_NEGATIVE_CACHE_TTL_SECONDS = 15 * 60;

/** Positive-cache TTL for a resolved Slack channel name / membership. */
export const SLACK_CHANNEL_INFO_CACHE_TTL_SECONDS = 600;
/** Negative-cache TTL when Slack reports the channel as inaccessible. */
export const SLACK_CHANNEL_INFO_NEGATIVE_CACHE_TTL_SECONDS = 60;

export const AUTO_START_EMPTY_SENTINEL = '__roomote_empty__';
export const AUTO_START_CHANNEL_CACHE_TTL_SECONDS = 60;

export async function syncAutoStartChannelCacheBestEffort(params: {
  redis: Redis;
  key: string;
  channelIds: string[];
  onError?: (error: unknown) => void;
}): Promise<void> {
  try {
    await params.redis.del(params.key);

    await params.redis.sadd(
      params.key,
      ...(params.channelIds.length > 0
        ? params.channelIds
        : [AUTO_START_EMPTY_SENTINEL]),
    );
    await params.redis.expire(params.key, AUTO_START_CHANNEL_CACHE_TTL_SECONDS);
  } catch (error) {
    params.onError?.(error);
  }
}

let redis: Redis | null = null;

const REDIS_MAX_RETRIES_PER_REQUEST = 3;
const REDIS_MAX_RECONNECT_DELAY_MS = 2_000;
const REDIS_ERROR_LOG_INTERVAL_MS = 30_000;

function observeRedisConnectivity(client: Redis): void {
  let outageStartedAt: number | null = null;
  let lastErrorLoggedAt = 0;
  let errorsSinceLastLog = 0;
  let totalErrors = 0;

  client.on('error', (error: Error & { code?: string }) => {
    const now = Date.now();
    outageStartedAt ??= now;
    errorsSinceLastLog += 1;
    totalErrors += 1;

    if (
      totalErrors > 1 &&
      now - lastErrorLoggedAt < REDIS_ERROR_LOG_INTERVAL_MS
    ) {
      return;
    }

    console.error(
      '[redis] connection degraded; dependent operations may fail',
      {
        code: error.code,
        message: error.message,
        suppressedErrors: Math.max(0, errorsSinceLastLog - 1),
      },
    );
    lastErrorLoggedAt = now;
    errorsSinceLastLog = 0;
  });

  client.on('ready', () => {
    if (outageStartedAt === null) {
      return;
    }

    console.info('[redis] connection restored', {
      outageDurationMs: Date.now() - outageStartedAt,
      totalErrors,
      suppressedErrors: errorsSinceLastLog,
    });
    outageStartedAt = null;
    lastErrorLoggedAt = 0;
    errorsSinceLastLog = 0;
    totalErrors = 0;
  });
}

function resolveRedisUrl(): string {
  // In apps/web on Vercel, dotenvx decrypts into process.env at runtime after
  // @roomote/env may already have snapshotted an earlier value.
  const redisUrl = process.env.REDIS_URL?.trim() || Env.REDIS_URL?.trim();

  if (!redisUrl) {
    throw new Error('REDIS_URL is not configured');
  }

  return redisUrl;
}

export const getRedis = () => {
  if (!redis) {
    redis = new Redis(resolveRedisUrl(), {
      maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
      connectTimeout: 5000,
      retryStrategy: (attempt) =>
        Math.min(attempt * 50, REDIS_MAX_RECONNECT_DELAY_MS),
    });
    observeRedisConnectivity(redis);
  }

  return redis;
};

export { acquireRedisLock, withRedisLock, withContention } from './lock';
export type {
  RedisLockOptions,
  RedisLockHandle,
  RedisLockRenewResult,
  LockResult,
  ContentionResult,
  ContentionOptions,
} from './lock';

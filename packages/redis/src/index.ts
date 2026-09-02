import type { Redis } from 'ioredis';

export type { Redis } from 'ioredis';
export { getRedis } from './client';
export {
  disconnectSessionPresence,
  isSessionUserPresent,
  refreshSessionPresence,
  SESSION_PRESENCE_LEASE_MS,
} from './session-presence';

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

export { acquireRedisLock, withRedisLock, withContention } from './lock';
export type {
  RedisLockOptions,
  RedisLockHandle,
  RedisLockRenewResult,
  LockResult,
  ContentionResult,
  ContentionOptions,
} from './lock';

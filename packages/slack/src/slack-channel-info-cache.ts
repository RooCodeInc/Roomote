import {
  getRedis,
  REDIS_KEYS,
  SLACK_CHANNEL_INFO_CACHE_TTL_SECONDS,
  SLACK_CHANNEL_INFO_NEGATIVE_CACHE_TTL_SECONDS,
} from '@roomote/redis';

/**
 * Flattened `conversations.info` projection: everything the notifier's channel
 * lookups need, so one Slack round trip answers name, membership and
 * visibility questions for a channel.
 */
export type SlackChannelInfo = {
  name: string | null;
  isMember: boolean | null;
  isPrivate: boolean | null;
  /** Slack reported `channel_not_found` / `not_in_channel`. */
  notFound: boolean;
};

function isSlackChannelInfo(value: unknown): value is SlackChannelInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    'notFound' in value &&
    typeof (value as SlackChannelInfo).notFound === 'boolean'
  );
}

/**
 * Two-layer cache for `conversations.info`.
 *
 * The in-memory memo is scoped to one instance (created per request by the
 * settings read path) so overlapping lookup rounds hit Slack once; the Redis
 * layer keeps that answer warm across requests. Both layers are best effort -
 * a Redis outage degrades to plain Slack calls.
 */
export class SlackChannelInfoCache {
  private readonly memo = new Map<string, Promise<SlackChannelInfo | null>>();

  /**
   * @param scope Workspace identity (Slack team id or installation id) the
   * cached entries belong to. Null disables the cross-request layer.
   */
  constructor(private readonly scope: string | null = null) {}

  public resolve(
    channelId: string,
    load: () => Promise<SlackChannelInfo | null>,
  ): Promise<SlackChannelInfo | null> {
    const memoized = this.memo.get(channelId);

    if (memoized) {
      return memoized;
    }

    const pending = this.loadThroughSharedCache(channelId, load);
    this.memo.set(channelId, pending);

    return pending;
  }

  private async loadThroughSharedCache(
    channelId: string,
    load: () => Promise<SlackChannelInfo | null>,
  ): Promise<SlackChannelInfo | null> {
    const cached = await this.read(channelId);

    if (cached) {
      return cached;
    }

    const info = await load();

    // Unresolved lookups (transport errors, unknown Slack errors) are not
    // cached so the next request can retry them.
    if (info) {
      await this.write(channelId, info);
    }

    return info;
  }

  private key(channelId: string): string {
    return `${REDIS_KEYS.SLACK_CHANNEL_INFO}:${this.scope}:${channelId}`;
  }

  private async read(channelId: string): Promise<SlackChannelInfo | null> {
    if (!this.scope) {
      return null;
    }

    try {
      const raw = await getRedis().get(this.key(channelId));

      if (!raw) {
        return null;
      }

      const parsed: unknown = JSON.parse(raw);

      return isSlackChannelInfo(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async write(
    channelId: string,
    info: SlackChannelInfo,
  ): Promise<void> {
    if (!this.scope) {
      return;
    }

    try {
      await getRedis().set(
        this.key(channelId),
        JSON.stringify(info),
        'EX',
        // A channel the bot cannot see or has not joined is a state the
        // operator is usually in the middle of fixing: cache it briefly so
        // inviting the bot is reflected in seconds, not minutes.
        info.notFound || info.isMember === false
          ? SLACK_CHANNEL_INFO_NEGATIVE_CACHE_TTL_SECONDS
          : SLACK_CHANNEL_INFO_CACHE_TTL_SECONDS,
      );
    } catch {
      // Best effort; the caller still uses the freshly fetched value.
    }
  }
}

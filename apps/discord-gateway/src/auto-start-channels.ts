const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

type DiscordAutoStartChannelResolver = () => Promise<string[]>;

/**
 * In-memory view of the Discord channels configured for channel auto-start,
 * refreshed from the database on an interval. The Gateway consults it to
 * forward unmentioned (and non-Roomote bot/webhook) guild messages from
 * monitored channels that its mention filtering would otherwise drop.
 *
 * Fails open to the last successfully loaded set: a transient database error
 * must degrade to slightly stale forwarding decisions, not silently disable
 * auto-respond channels.
 */
export class DiscordAutoStartChannelTracker {
  private channelIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly options: {
      refreshIntervalMs?: number;
      onError?: (error: unknown) => void;
      /** Test seam; defaults to the @roomote/db/server export. */
      resolveChannelIds?: DiscordAutoStartChannelResolver;
    } = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    void this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isAutoStartChannel(channelId: string): boolean {
    return this.channelIds.has(channelId);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return this.refreshing;
    }

    this.refreshing = (async () => {
      try {
        const resolver =
          this.options.resolveChannelIds ?? (await this.loadDatabaseResolver());
        if (!resolver) {
          return;
        }
        this.channelIds = new Set(await resolver());
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  private async loadDatabaseResolver(): Promise<DiscordAutoStartChannelResolver | null> {
    // Same tolerant boundary as credentials.ts: during rolling deploys the
    // gateway image can be newer than the database package loaded by another
    // control-plane app, so the export may be missing.
    const dbServer = (await import('@roomote/db/server')) as unknown as {
      getDiscordAutoStartChannelIds?: DiscordAutoStartChannelResolver;
    };
    return dbServer.getDiscordAutoStartChannelIds ?? null;
  }
}

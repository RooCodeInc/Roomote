import { DiscordAutoStartChannelTracker } from './auto-start-channels';

describe('DiscordAutoStartChannelTracker', () => {
  it('reflects the resolved channel set after a refresh', async () => {
    const tracker = new DiscordAutoStartChannelTracker({
      resolveChannelIds: async () => ['channel-1', 'channel-2'],
    });

    expect(tracker.isAutoStartChannel('channel-1')).toBe(false);
    await tracker.refresh();
    expect(tracker.isAutoStartChannel('channel-1')).toBe(true);
    expect(tracker.isAutoStartChannel('channel-2')).toBe(true);
    expect(tracker.isAutoStartChannel('channel-3')).toBe(false);
  });

  it('keeps the last-known set when a refresh fails', async () => {
    const onError = vi.fn();
    let shouldFail = false;
    const tracker = new DiscordAutoStartChannelTracker({
      onError,
      resolveChannelIds: async () => {
        if (shouldFail) {
          throw new Error('database unavailable');
        }
        return ['channel-1'];
      },
    });

    await tracker.refresh();
    expect(tracker.isAutoStartChannel('channel-1')).toBe(true);

    shouldFail = true;
    await tracker.refresh();

    // Fail-open to stale data rather than silently disabling the feature.
    expect(tracker.isAutoStartChannel('channel-1')).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('drops channels removed from the configuration', async () => {
    let channelIds = ['channel-1', 'channel-2'];
    const tracker = new DiscordAutoStartChannelTracker({
      resolveChannelIds: async () => channelIds,
    });

    await tracker.refresh();
    channelIds = ['channel-2'];
    await tracker.refresh();

    expect(tracker.isAutoStartChannel('channel-1')).toBe(false);
    expect(tracker.isAutoStartChannel('channel-2')).toBe(true);
  });

  it('coalesces concurrent refreshes into one resolver call', async () => {
    const resolveChannelIds = vi.fn(async () => ['channel-1']);
    const tracker = new DiscordAutoStartChannelTracker({ resolveChannelIds });

    await Promise.all([tracker.refresh(), tracker.refresh()]);

    expect(resolveChannelIds).toHaveBeenCalledTimes(1);
  });

  it('starts polling on start() and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const resolveChannelIds = vi.fn(async () => ['channel-1']);
      const tracker = new DiscordAutoStartChannelTracker({
        refreshIntervalMs: 1_000,
        resolveChannelIds,
      });

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveChannelIds).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_100);
      expect(resolveChannelIds).toHaveBeenCalledTimes(3);

      tracker.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(resolveChannelIds).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

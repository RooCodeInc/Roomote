import { createFastAgentTypingActivity } from './fast-agent-typing-activity';

describe('Fast typing activity', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([4_000, 8_000])(
    'starts once and repeats every %i ms',
    async (intervalMs) => {
      const sendTyping = vi.fn().mockResolvedValue(undefined);
      const activity = createFastAgentTypingActivity({
        sendTyping,
        intervalMs,
      });
      activity.reassert();
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(sendTyping).not.toHaveBeenCalled();
      activity.start();
      activity.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTyping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(intervalMs - 1);
      expect(sendTyping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTyping).toHaveBeenCalledTimes(2);
      await activity.settle();
    },
  );

  it('serializes requests and coalesces reassertions behind an in-flight request', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const sendTyping = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(undefined);
    const activity = createFastAgentTypingActivity({
      sendTyping,
      intervalMs: 4_000,
    });
    activity.start();
    await vi.advanceTimersByTimeAsync(20_000);
    activity.reassert();
    activity.reassert();
    expect(sendTyping).toHaveBeenCalledTimes(1);
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);
    await activity.dispose();
  });

  it('continues after synchronous and asynchronous provider errors', async () => {
    const sendTyping = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('sync');
      })
      .mockRejectedValueOnce(new Error('async'))
      .mockResolvedValue(undefined);
    const activity = createFastAgentTypingActivity({
      sendTyping,
      intervalMs: 4_000,
    });
    activity.start();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);
    await activity.settle();
  });

  it.each(['settle', 'dispose', 'park'] as const)(
    'fences and drains on %s, without late restarts',
    async (mode) => {
      let resolveRequest!: () => void;
      const request = new Promise<void>((resolve) => {
        resolveRequest = resolve;
      });
      const sendTyping = vi.fn(() => request);
      const activity = createFastAgentTypingActivity({
        sendTyping,
        intervalMs: 4_000,
      });
      activity.start();
      await vi.advanceTimersByTimeAsync(0);
      activity.reassert();
      const stop =
        mode === 'dispose'
          ? activity.dispose()
          : activity.settle({ keepProcessing: mode === 'park' });
      expect(activity.dispose()).toBe(stop);
      let drained = false;
      void stop.then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(drained).toBe(false);
      resolveRequest();
      await stop;
      activity.start();
      activity.reassert();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sendTyping).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('cancels a start before its request is issued', async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTypingActivity({
      sendTyping,
      intervalMs: 4_000,
    });
    activity.start();
    await activity.dispose();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it('reasserts immediately after a post and resets the heartbeat deadline', async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTypingActivity({
      sendTyping,
      intervalMs: 4_000,
    });
    activity.start();
    await vi.advanceTimersByTimeAsync(2_000);
    activity.reassert();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendTyping).toHaveBeenCalledTimes(3);
    await activity.settle();
  });
});

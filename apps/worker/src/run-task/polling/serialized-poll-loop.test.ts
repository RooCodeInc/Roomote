import { createSerializedPollLoop } from './serialized-poll-loop';

const INTERVAL_MS = 5_000;
const STALL_TIMEOUT_MS = 60_000;

describe('createSerializedPollLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not overlap polls while the previous poll is still running', async () => {
    let resolveActive: (() => void) | undefined;
    const pollOnce = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveActive = resolve;
        }),
    );

    const { interval, cleanup } = createSerializedPollLoop({
      pollOnce,
      intervalMs: INTERVAL_MS,
      stallTimeoutMs: STALL_TIMEOUT_MS,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(pollOnce).toHaveBeenCalledTimes(1);

    resolveActive?.();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(pollOnce).toHaveBeenCalledTimes(2);

    clearInterval(interval);
    resolveActive?.();
    await cleanup();
  });

  it('abandons a hung poll after the stall deadline and keeps polling', async () => {
    let hangs = 0;
    const pollOnce = vi.fn(() => {
      hangs += 1;

      if (hangs === 1) {
        return new Promise<void>(() => {});
      }

      return Promise.resolve();
    });
    const onStall = vi.fn();

    const { interval, cleanup } = createSerializedPollLoop({
      pollOnce,
      intervalMs: INTERVAL_MS,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      onStall,
    });

    // First tick starts the hung poll; nothing else runs until the deadline.
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    expect(onStall).not.toHaveBeenCalled();

    // The first tick past the deadline reports the stall and starts fresh.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith({
      stalledForMs: expect.any(Number),
    });
    expect(pollOnce).toHaveBeenCalledTimes(2);

    // Polling continues normally afterwards.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(pollOnce).toHaveBeenCalledTimes(4);
    expect(onStall).toHaveBeenCalledTimes(1);

    clearInterval(interval);
    await cleanup();
  });

  it('reports when an abandoned poll eventually settles', async () => {
    let resolveHung: (() => void) | undefined;
    let calls = 0;
    const pollOnce = vi.fn(() => {
      calls += 1;

      if (calls === 1) {
        return new Promise<void>((resolve) => {
          resolveHung = resolve;
        });
      }

      return Promise.resolve();
    });
    const onStall = vi.fn();
    const onStallRecovered = vi.fn();

    const { interval, cleanup } = createSerializedPollLoop({
      pollOnce,
      intervalMs: INTERVAL_MS,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      onStall,
      onStallRecovered,
    });

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + INTERVAL_MS);
    expect(onStall).toHaveBeenCalledTimes(1);

    resolveHung?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStallRecovered).toHaveBeenCalledTimes(1);
    expect(onStallRecovered).toHaveBeenCalledWith({
      ranForMs: expect.any(Number),
    });

    clearInterval(interval);
    await cleanup();
  });

  it('swallows poll rejections without stopping the loop', async () => {
    const pollOnce = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    const { interval, cleanup } = createSerializedPollLoop({
      pollOnce,
      intervalMs: INTERVAL_MS,
      stallTimeoutMs: STALL_TIMEOUT_MS,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(pollOnce).toHaveBeenCalledTimes(3);

    clearInterval(interval);
    await cleanup();
  });

  it('bounds cleanup when the in-flight poll is wedged', async () => {
    const pollOnce = vi.fn(() => new Promise<void>(() => {}));

    const { interval, cleanup } = createSerializedPollLoop({
      pollOnce,
      intervalMs: INTERVAL_MS,
      stallTimeoutMs: STALL_TIMEOUT_MS,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(pollOnce).toHaveBeenCalledTimes(1);

    clearInterval(interval);

    let cleanupDone = false;
    const pending = cleanup().then(() => {
      cleanupDone = true;
    });

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 1);
    expect(cleanupDone).toBe(false);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await pending;
    expect(cleanupDone).toBe(true);
  });

  it('stops starting polls after cleanup', async () => {
    const pollOnce = vi.fn(() => Promise.resolve());

    const { interval, cleanup } = createSerializedPollLoop({
      pollOnce,
      intervalMs: INTERVAL_MS,
      stallTimeoutMs: STALL_TIMEOUT_MS,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(pollOnce).toHaveBeenCalledTimes(1);

    await cleanup();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(pollOnce).toHaveBeenCalledTimes(1);

    clearInterval(interval);
  });
});

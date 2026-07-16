import { enqueueDiscordInboundWithRetry } from './enqueue-retry';

describe('enqueueDiscordInboundWithRetry', () => {
  it('retries transient failures with bounded exponential delays', async () => {
    const enqueue = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockRejectedValueOnce(new Error('redis reconnecting'))
      .mockResolvedValueOnce(true);
    const wait = vi.fn(async () => undefined);

    await expect(
      enqueueDiscordInboundWithRetry({
        enqueue,
        signal: new AbortController().signal,
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        wait,
      }),
    ).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 10, expect.any(AbortSignal));
    expect(wait).toHaveBeenNthCalledWith(2, 20, expect.any(AbortSignal));
  });

  it('stops after the configured attempt bound', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('redis unavailable');
    });

    await expect(
      enqueueDiscordInboundWithRetry({
        enqueue,
        signal: new AbortController().signal,
        maxAttempts: 3,
        wait: async () => undefined,
      }),
    ).rejects.toThrow('failed after 3 attempts');
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it('stops immediately when its connection is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('handoff'));
    const enqueue = vi.fn(async () => true);

    await expect(
      enqueueDiscordInboundWithRetry({
        enqueue,
        signal: controller.signal,
      }),
    ).rejects.toThrow('handoff');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

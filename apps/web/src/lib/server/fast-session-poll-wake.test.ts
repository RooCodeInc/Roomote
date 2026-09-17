import { createFastSessionPollWake } from './fast-session-poll-wake';

describe('createFastSessionPollWake', () => {
  it('consumes a refresh requested before the poll begins waiting', async () => {
    const wake = createFastSessionPollWake(10_000);
    wake.request();
    await expect(wake.wait()).resolves.toBe('requested');
  });

  it('wakes an active wait immediately and keeps the interval as fallback', async () => {
    vi.useFakeTimers();
    try {
      const wake = createFastSessionPollWake(1_000);
      const requested = wake.wait();
      wake.request();
      await expect(requested).resolves.toBe('requested');

      const fallback = wake.wait();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(fallback).resolves.toBe('interval');
    } finally {
      vi.useRealTimers();
    }
  });
});

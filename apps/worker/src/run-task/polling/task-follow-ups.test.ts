import { createTaskFollowUpInterval } from './task-follow-ups';

describe('createTaskFollowUpInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains immediately and on the polling cadence', async () => {
    const drain = vi.fn().mockResolvedValue(undefined);
    const interval = createTaskFollowUpInterval({
      drain,
      logger: { warn: vi.fn() },
    });

    expect(drain).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(drain).toHaveBeenCalledTimes(3);
    clearInterval(interval);
  });

  it('does not surface a rejected drain as an unhandled timer error', async () => {
    const error = new Error('temporary API outage');
    const warn = vi.fn();
    const drain = vi.fn().mockRejectedValue(error);
    const interval = createTaskFollowUpInterval({
      drain,
      logger: { warn },
    });

    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      '[task-follow-ups] Failed to drain queued task follow-ups: temporary API outage',
    );
    clearInterval(interval);
  });
});

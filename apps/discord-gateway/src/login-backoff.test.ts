import { DiscordLoginBackoff } from './login-backoff';

describe('DiscordLoginBackoff', () => {
  it('opens a capped exponential circuit for repeated same-token failures', () => {
    const backoff = new DiscordLoginBackoff(1_000, 4_000);

    expect(backoff.canAttempt('token-a', 0)).toBe(true);
    expect(backoff.recordFailure('token-a', 0)).toMatchObject({
      attempts: 1,
      delayMs: 1_000,
      nextAttemptAt: 1_000,
    });
    expect(backoff.canAttempt('token-a', 999)).toBe(false);
    expect(backoff.canAttempt('token-a', 1_000)).toBe(true);

    expect(backoff.recordFailure('token-a', 1_000)).toMatchObject({
      attempts: 2,
      delayMs: 2_000,
      nextAttemptAt: 3_000,
    });
    expect(backoff.recordFailure('token-a', 3_000)).toMatchObject({
      attempts: 3,
      delayMs: 4_000,
      nextAttemptAt: 7_000,
    });
    expect(backoff.recordFailure('token-a', 7_000)).toMatchObject({
      attempts: 4,
      delayMs: 4_000,
      nextAttemptAt: 11_000,
    });
  });

  it('allows a changed token immediately and resets after success', () => {
    const backoff = new DiscordLoginBackoff(1_000, 4_000);
    backoff.recordFailure('token-a', 0);

    expect(backoff.canAttempt('token-b', 1)).toBe(true);
    backoff.recordFailure('token-b', 1);
    expect(backoff.canAttempt('token-b', 2)).toBe(false);

    backoff.reset('token-b');
    expect(backoff.canAttempt('token-b', 2)).toBe(true);
    expect(backoff.getState('token-b')).toBeNull();
  });
});

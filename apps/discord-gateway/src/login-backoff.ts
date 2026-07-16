type DiscordLoginBackoffState = {
  tokenFingerprint: string;
  attempts: number;
  delayMs: number;
  nextAttemptAt: number;
};

/**
 * A small per-token circuit breaker for Discord login failures. A changed
 * token gets one immediate attempt; repeated failures for the same token are
 * spaced out with a capped exponential delay.
 */
export class DiscordLoginBackoff {
  private state: DiscordLoginBackoffState | null = null;

  constructor(
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
  ) {}

  canAttempt(tokenFingerprint: string, now = Date.now()): boolean {
    return (
      this.state?.tokenFingerprint !== tokenFingerprint ||
      now >= this.state.nextAttemptAt
    );
  }

  recordFailure(
    tokenFingerprint: string,
    now = Date.now(),
  ): DiscordLoginBackoffState {
    const attempts =
      this.state?.tokenFingerprint === tokenFingerprint
        ? this.state.attempts + 1
        : 1;
    const exponent = Math.min(attempts - 1, 30);
    const delayMs = Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
    this.state = {
      tokenFingerprint,
      attempts,
      delayMs,
      nextAttemptAt: now + delayMs,
    };
    return { ...this.state };
  }

  reset(tokenFingerprint?: string): void {
    if (
      tokenFingerprint === undefined ||
      this.state?.tokenFingerprint === tokenFingerprint
    ) {
      this.state = null;
    }
  }

  getState(tokenFingerprint: string): DiscordLoginBackoffState | null {
    return this.state?.tokenFingerprint === tokenFingerprint
      ? { ...this.state }
      : null;
  }
}

const DEFAULT_ATTEMPT_THROTTLE_MS = 5_000;
const DEFAULT_BACKGROUND_RETRY_INTERVAL_MS = 60_000;

interface StartSandboxLiveAutoRecoveryOptions {
  /**
   * Whether an automatic reconnect attempt should run right now. Checked at
   * trigger time so callers can read live store state.
   */
  isEligible: () => boolean;
  /** Kick off a reconnect attempt (same path as the manual Reconnect button). */
  triggerReconnect: () => void;
  attemptThrottleMs?: number;
  backgroundRetryIntervalMs?: number;
}

/**
 * Automatically retries an exhausted sandbox live connection when the
 * environment suggests a new attempt could succeed: the browser regains
 * network, the tab becomes visible again (e.g. laptop wake), or a slow
 * background interval elapses. Without this, an exhausted retry budget left
 * the task page disconnected until the user clicked Reconnect, even after
 * transient client-side blips.
 *
 * Returns a cleanup function that removes all listeners and timers.
 */
export function startSandboxLiveAutoRecovery({
  isEligible,
  triggerReconnect,
  attemptThrottleMs = DEFAULT_ATTEMPT_THROTTLE_MS,
  backgroundRetryIntervalMs = DEFAULT_BACKGROUND_RETRY_INTERVAL_MS,
}: StartSandboxLiveAutoRecoveryOptions): () => void {
  let lastAttemptAt = Number.NEGATIVE_INFINITY;

  const attempt = () => {
    if (!isEligible()) {
      return;
    }

    const now = Date.now();

    if (now - lastAttemptAt < attemptThrottleMs) {
      return;
    }

    lastAttemptAt = now;
    triggerReconnect();
  };

  const handleOnline = () => {
    attempt();
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      attempt();
    }
  };

  window.addEventListener('online', handleOnline);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  const backgroundRetryInterval = setInterval(
    attempt,
    backgroundRetryIntervalMs,
  );

  return () => {
    window.removeEventListener('online', handleOnline);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    clearInterval(backgroundRetryInterval);
  };
}

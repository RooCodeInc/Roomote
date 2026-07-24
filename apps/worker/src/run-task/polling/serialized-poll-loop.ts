/**
 * Serialized polling with a stall watchdog.
 *
 * The message pollers must not overlap (delivery order and requeue bookkeeping
 * assume one poll at a time), but the previous implementation chained every
 * tick onto the last poll's promise — a single poll that never settled
 * silently stopped all future polls for the rest of the run. This loop keeps
 * the serialization while bounding each poll: an in-flight poll that exceeds
 * the stall deadline is reported and abandoned so the next tick starts fresh.
 */

/**
 * Comfortably above the worst-case legitimate poll (SDK fetches are bounded
 * per attempt and retried a few times, plus actor-scoped turn preparation), so
 * a stall report means the poll is genuinely wedged, not slow.
 */
const DEFAULT_POLL_STALL_TIMEOUT_MS = 5 * 60_000;

interface SerializedPollLoopOptions {
  pollOnce: () => Promise<void>;
  intervalMs: number;
  stallTimeoutMs?: number;
  /** Invoked once per stalled poll, right before the poll is abandoned. */
  onStall?: (info: { stalledForMs: number }) => void;
  /** Invoked if an abandoned poll eventually settles after all. */
  onStallRecovered?: (info: { ranForMs: number }) => void;
}

interface SerializedPollLoop {
  interval: NodeJS.Timeout;
  /**
   * Stop scheduling and wait for the in-flight poll to settle, bounded by the
   * stall deadline so a wedged poll cannot hang shutdown.
   */
  cleanup: () => Promise<void>;
}

interface InFlightPoll {
  promise: Promise<void>;
  startedAt: number;
  abandoned: boolean;
}

export function createSerializedPollLoop({
  pollOnce,
  intervalMs,
  stallTimeoutMs = DEFAULT_POLL_STALL_TIMEOUT_MS,
  onStall,
  onStallRecovered,
}: SerializedPollLoopOptions): SerializedPollLoop {
  let stopping = false;
  let inFlight: InFlightPoll | null = null;

  const startPoll = () => {
    const poll: InFlightPoll = {
      promise: Promise.resolve(),
      startedAt: Date.now(),
      abandoned: false,
    };

    poll.promise = (async () => {
      try {
        await pollOnce();
      } finally {
        if (inFlight === poll) {
          inFlight = null;
        } else if (poll.abandoned) {
          onStallRecovered?.({ ranForMs: Date.now() - poll.startedAt });
        }
      }
    })().catch(() => {
      // pollOnce handles its own errors; this guard only prevents an
      // unhandled rejection from an abandoned poll.
    });

    inFlight = poll;
  };

  const interval = setInterval(() => {
    if (stopping) {
      return;
    }

    if (!inFlight) {
      startPoll();
      return;
    }

    const stalledForMs = Date.now() - inFlight.startedAt;

    if (stalledForMs < stallTimeoutMs) {
      // Previous poll is still running; skip this tick instead of queueing
      // behind it.
      return;
    }

    inFlight.abandoned = true;
    inFlight = null;
    onStall?.({ stalledForMs });
    startPoll();
  }, intervalMs);

  const cleanup = async () => {
    stopping = true;

    const pending = inFlight;

    if (!pending) {
      return;
    }

    const remainingMs = Math.max(
      0,
      stallTimeoutMs - (Date.now() - pending.startedAt),
    );

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, remainingMs);

      void pending.promise.finally(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  };

  return { interval, cleanup };
}

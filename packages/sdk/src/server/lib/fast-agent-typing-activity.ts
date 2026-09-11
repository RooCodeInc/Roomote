import type { FastAgentTurnActivity } from '@roomote/cloud-agents/server';

export function createFastAgentTypingActivity({
  sendTyping,
  intervalMs,
}: {
  sendTyping: () => Promise<void>;
  intervalMs: number | (() => number);
}): FastAgentTurnActivity & {
  reassert: () => void;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
} {
  let started = false;
  let stopped = false;
  let paused = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const reassert = () => {
    if (!started || stopped || paused) return;
    clearTimeout(timer);
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = Promise.resolve()
      .then(() => {
        if (!stopped && !paused) return sendTyping();
      })
      .catch(() => {
        // Typing is best effort; a provider failure must not fail the turn.
      })
      .finally(() => {
        inFlight = undefined;
        if (stopped || paused) return;
        if (pending) {
          pending = false;
          reassert();
        } else {
          timer = setTimeout(
            reassert,
            typeof intervalMs === 'function' ? intervalMs() : intervalMs,
          );
          timer.unref();
        }
      });
  };
  const stop = () => {
    stopped = true;
    paused = true;
    pending = false;
    clearTimeout(timer);
    return inFlight ?? Promise.resolve();
  };
  const pause = async () => {
    paused = true;
    pending = false;
    clearTimeout(timer);
    while (inFlight) await inFlight;
  };

  return {
    start: () => {
      if (started || stopped) return;
      started = true;
      reassert();
    },
    reassert,
    pause,
    resume: () => {
      if (!started || stopped) return Promise.resolve();
      paused = false;
      reassert();
      return inFlight ?? Promise.resolve();
    },
    // Durable parking preserves processing state, not this owner's typing.
    settle: stop,
    dispose: stop,
  };
}

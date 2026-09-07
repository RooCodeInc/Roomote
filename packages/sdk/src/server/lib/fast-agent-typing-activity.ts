import type { FastAgentTurnActivity } from '@roomote/cloud-agents/server';

export function createFastAgentTypingActivity({
  sendTyping,
  intervalMs,
}: {
  sendTyping: () => Promise<void>;
  intervalMs: number;
}): FastAgentTurnActivity & {
  reassert: () => void;
} {
  let started = false;
  let stopped = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const reassert = () => {
    if (!started || stopped) return;
    clearTimeout(timer);
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = Promise.resolve()
      .then(() => {
        if (!stopped) return sendTyping();
      })
      .catch(() => {
        // Typing is best effort; a provider failure must not fail the turn.
      })
      .finally(() => {
        inFlight = undefined;
        if (stopped) return;
        if (pending) {
          pending = false;
          reassert();
        } else {
          timer = setTimeout(reassert, intervalMs);
          timer.unref();
        }
      });
  };
  const stop = () => {
    stopped = true;
    pending = false;
    clearTimeout(timer);
    return inFlight ?? Promise.resolve();
  };

  return {
    start: () => {
      if (started || stopped) return;
      started = true;
      reassert();
    },
    reassert,
    // Durable parking preserves processing state, not this owner's typing.
    settle: stop,
    dispose: stop,
  };
}

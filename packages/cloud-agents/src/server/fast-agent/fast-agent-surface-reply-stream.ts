import type {
  FastAgentReply,
  FastAgentReplyHandle,
  FastAgentReplyStream,
} from './fast-agent-conversation';

/**
 * A reply still being written this long after its text started streaming
 * opens a surface stream; a reply that finishes sooner posts as one message,
 * which keeps short answers from spending a stream on every turn.
 */
export const FAST_AGENT_SURFACE_STREAM_START_DELAY_MS = 750;
/** Minimum spacing between appends to one surface stream. */
export const FAST_AGENT_SURFACE_STREAM_INTERVAL_MS = 500;

/**
 * Drives one surface reply stream at a time from the turn's undelivered
 * reply text. Appends are coalesced and rate-paced; the delivering reply
 * finishes the stream and takes over its message. Every surface call is
 * serialized and best effort: a failure leaves the persisted delivery path
 * untouched.
 */
export function createFastAgentSurfaceReplyStreamer(options: {
  createStream?: () => FastAgentReplyStream;
  startDelayMs?: number;
  intervalMs?: number;
}) {
  const startDelayMs =
    options.startDelayMs ?? FAST_AGENT_SURFACE_STREAM_START_DELAY_MS;
  const intervalMs =
    options.intervalMs ?? FAST_AGENT_SURFACE_STREAM_INTERVAL_MS;
  let stream: FastAgentReplyStream | undefined;
  let sentText = '';
  let latestText = '';
  let latestIncomplete = false;
  let startTimer: NodeJS.Timeout | undefined;
  let appendTimer: NodeJS.Timeout | undefined;
  let lastAppendAtMs = 0;
  let chain: Promise<void> = Promise.resolve();

  const run = (step: () => Promise<void>) => {
    chain = chain.then(step).catch((error) => {
      console.warn(
        `[Fast Agent] Surface reply stream step failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const clearTimers = () => {
    if (startTimer) clearTimeout(startTimer);
    if (appendTimer) clearTimeout(appendTimer);
    startTimer = undefined;
    appendTimer = undefined;
  };
  const appendPending = () => {
    appendTimer = undefined;
    const active = stream;
    if (!active) return;
    // Only appends stream; a rewrite of earlier text is left to the finish.
    if (!latestText.startsWith(sentText)) return;
    const delta = latestText.slice(sentText.length);
    if (!delta) return;
    sentText = latestText;
    lastAppendAtMs = Date.now();
    run(() => active.append(delta));
  };
  const scheduleAppend = () => {
    if (appendTimer || !stream) return;
    const wait = Math.max(0, lastAppendAtMs + intervalMs - Date.now());
    appendTimer = setTimeout(appendPending, wait);
    appendTimer.unref?.();
  };
  const reset = () => {
    clearTimers();
    const active = stream;
    stream = undefined;
    sentText = '';
    latestText = '';
    latestIncomplete = false;
    return active;
  };

  return {
    /** The undelivered reply text so far and whether it is still growing. */
    update(text: string, incomplete: boolean): void {
      const createStream = options.createStream;
      if (!createStream) return;
      latestText = text;
      latestIncomplete = incomplete;
      if (stream) {
        scheduleAppend();
        return;
      }
      if (startTimer) return;
      startTimer = setTimeout(() => {
        startTimer = undefined;
        if (stream || !latestIncomplete || !latestText.trim()) return;
        const opened = createStream();
        stream = opened;
        sentText = latestText;
        lastAppendAtMs = Date.now();
        const text = latestText;
        run(() => opened.append(text));
      }, startDelayMs);
      startTimer.unref?.();
    },
    /**
     * Finishes the active stream with the reply that delivers it. Returns
     * the message the reply now lives in, or nothing when no stream carried
     * it so the caller posts the reply itself.
     */
    async deliver(
      reply: FastAgentReply,
    ): Promise<FastAgentReplyHandle | undefined> {
      const active = reset();
      if (!active) return undefined;
      await chain;
      try {
        return await active.finish(reply);
      } catch (error) {
        console.warn(
          `[Fast Agent] Failed to finish a surface reply stream: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    },
    /** Ends the active stream without a reply, leaving its text as is. */
    async abort(): Promise<void> {
      const active = reset();
      if (!active) return;
      await chain;
      await active.abort().catch((error) => {
        console.warn(
          `[Fast Agent] Failed to end a surface reply stream: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  };
}

export type FastAgentSurfaceReplyStreamer = ReturnType<
  typeof createFastAgentSurfaceReplyStreamer
>;

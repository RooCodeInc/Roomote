import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LOGICAL_EVENT_ID_KEY,
  buildAcpLogicalEventId,
  inferAcpMessageKind,
  type AcpMessage,
} from '@roomote/types';
import { getRedis } from '@roomote/redis';

/**
 * Live delivery of a Fast reply while the model is still writing it.
 *
 * The model's plain assistant text is the reply. OpenCode streams that text
 * part by part; the turn tracks which parts have been delivered (by a
 * `send_chat_reply` call or the terminal closeout) and publishes the
 * undelivered remainder to Redis as `assistant_message_chunk` events, the
 * same envelope the task runtime streams for live assistant text. The web
 * session stream forwards them and the transcript reassembles them with the
 * task transcript's protocol service until the persisted row replaces them.
 */

export const FAST_AGENT_REPLY_STREAM_CHANNEL_PREFIX = 'fast-agent:reply-stream';

export function getFastAgentReplyStreamChannel(conversationId: string) {
  return `${FAST_AGENT_REPLY_STREAM_CHANNEL_PREFIX}:${conversationId}`;
}

export type FastAgentReplyChunk = {
  /** The canonical event the finished reply persists under. */
  eventId: string;
  /** OpenCode session and assistant message ids, as task chunks carry. */
  sessionId: string | null;
  turnId: string | null;
  ts: number;
  /** Text appended since the previous chunk of the same reply. */
  text: string;
};

/**
 * The chunk as the task runtime would stream it. `id` is the reply's event
 * id so every chunk of one reply extends the same live message, and the
 * client can drop that message once the row with that eventId is persisted.
 */
export function buildFastAgentReplyChunkEvent(
  chunk: FastAgentReplyChunk,
): AcpMessage {
  const eventType = ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk;
  const logicalEventId = buildAcpLogicalEventId({
    sessionId: chunk.sessionId,
    turnId: chunk.turnId,
    eventType,
  });
  const identity = {
    ...(chunk.sessionId ? { sessionId: chunk.sessionId } : {}),
    ...(chunk.turnId ? { turnId: chunk.turnId } : {}),
    ...(logicalEventId ? { [ACP_LOGICAL_EVENT_ID_KEY]: logicalEventId } : {}),
  };
  return {
    id: chunk.eventId,
    kind: inferAcpMessageKind(eventType),
    ts: chunk.ts,
    eventType,
    role: 'assistant',
    contentBlocks: [{ type: 'text', text: chunk.text }],
    metadata: { ...identity, replyEventId: chunk.eventId },
    payload: { ...identity, text: chunk.text },
    ...(logicalEventId ? { logicalEventId } : {}),
    text: chunk.text,
  };
}

/** One assistant text part as observed from the OpenCode event stream. */
export type FastAgentAssistantTextUpdate = {
  messageId: string;
  partId: string;
  /** The part's full text so far, when the event carries it. */
  text?: string;
  /** Text appended since the previous update, when only a delta is known. */
  delta?: string;
  /** True once the part has finished streaming. */
  completed?: boolean;
};

type TrackedTextPart = {
  order: number;
  messageId: string;
  text: string;
  completed: boolean;
  consumed: boolean;
};

/**
 * Orders the model's text parts and remembers which have been delivered.
 * Text is joined without separators, matching how the OpenCode prompt
 * result concatenates a message's text parts.
 */
export function createFastAgentReplyTextTracker() {
  const parts = new Map<string, TrackedTextPart>();
  let nextOrder = 0;

  const ordered = () => [...parts.values()].sort((a, b) => a.order - b.order);
  const unconsumed = () => ordered().filter((part) => !part.consumed);

  return {
    /** Returns true when this update started a new text part. */
    apply(update: FastAgentAssistantTextUpdate): { newPart: boolean } {
      let part = parts.get(update.partId);
      const newPart = part === undefined;
      if (!part) {
        part = {
          order: nextOrder++,
          messageId: update.messageId,
          text: '',
          completed: false,
          consumed: false,
        };
        parts.set(update.partId, part);
      }
      if (update.text !== undefined) {
        part.text = update.text;
      } else if (update.delta) {
        part.text += update.delta;
      }
      if (update.completed) {
        part.completed = true;
      }
      return { newPart };
    },
    /** True once any text part has been observed this turn. */
    sawText(): boolean {
      return parts.size > 0;
    },
    unconsumedText(): string {
      return unconsumed()
        .map((part) => part.text)
        .join('');
    },
    hasIncompleteUnconsumed(): boolean {
      return unconsumed().some((part) => !part.completed);
    },
    /** Marks every undelivered part delivered and returns their text. */
    consumeUnconsumed(): string {
      const pending = unconsumed();
      for (const part of pending) part.consumed = true;
      return pending.map((part) => part.text).join('');
    },
    /** Text already delivered from the given assistant message, in order. */
    consumedText(messageId: string): string {
      return ordered()
        .filter((part) => part.consumed && part.messageId === messageId)
        .map((part) => part.text)
        .join('');
    },
  };
}

export type FastAgentReplyTextTracker = ReturnType<
  typeof createFastAgentReplyTextTracker
>;

export const FAST_AGENT_REPLY_STREAM_INTERVAL_MS = 150;

type PublishFn = (channel: string, payload: string) => Promise<unknown>;

function defaultPublish(): PublishFn | undefined {
  try {
    const redis = getRedis();
    return (channel, payload) => redis.publish(channel, payload);
  } catch (error) {
    console.warn(
      `[Fast Agent] Reply streaming is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Best-effort, throttled publisher for reply chunks. Deltas of one reply
 * coalesce so a fast token stream publishes at most one chunk per interval.
 * Failures are logged, never thrown: the persisted row is the durable
 * delivery and arrives regardless.
 */
export function createFastAgentReplyStreamPublisher(options: {
  getConversationId: () => string | null | undefined;
  intervalMs?: number;
  publish?: PublishFn;
}) {
  const intervalMs = options.intervalMs ?? FAST_AGENT_REPLY_STREAM_INTERVAL_MS;
  let publish: PublishFn | undefined | null = options.publish ?? null;
  let pending: FastAgentReplyChunk | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lastSentAtMs = 0;
  let inFlight: Promise<void> = Promise.resolve();

  const send = async (chunk: FastAgentReplyChunk) => {
    const conversationId = options.getConversationId();
    if (!conversationId) return;
    if (publish === null) publish = defaultPublish();
    if (!publish) return;
    try {
      await publish(
        getFastAgentReplyStreamChannel(conversationId),
        JSON.stringify(buildFastAgentReplyChunkEvent(chunk)),
      );
    } catch (error) {
      console.warn(
        `[Fast Agent] Failed to publish a reply chunk: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const flushPending = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const chunk = pending;
    pending = undefined;
    if (!chunk) return;
    lastSentAtMs = Date.now();
    inFlight = inFlight.then(() => send(chunk));
  };

  return {
    publishChunk(chunk: FastAgentReplyChunk): void {
      if (chunk.text.length === 0) return;
      if (pending && pending.eventId === chunk.eventId) {
        pending = { ...chunk, text: pending.text + chunk.text };
      } else {
        if (pending) flushPending();
        pending = chunk;
      }
      if (timer) return;
      const wait = Math.max(0, lastSentAtMs + intervalMs - Date.now());
      timer = setTimeout(flushPending, wait);
      timer.unref?.();
    },
    /** Sends whatever is pending immediately and waits for delivery. */
    async flush(): Promise<void> {
      flushPending();
      await inFlight;
    },
    async dispose(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = undefined;
      await inFlight;
    },
  };
}

export type FastAgentReplyStreamPublisher = ReturnType<
  typeof createFastAgentReplyStreamPublisher
>;

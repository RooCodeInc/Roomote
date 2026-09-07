import { z } from 'zod';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  inferAcpMessageKind,
  type AcpMessage,
} from '@roomote/types';
import { getFastAgentReplyStreamChannel } from '@roomote/cloud-agents/server';
import { getRedis, type Redis } from '@roomote/redis';

const replyChunkEventSchema = z.object({
  id: z.string().min(1),
  ts: z.number(),
  eventType: z.literal(ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk),
  role: z.literal('assistant'),
  contentBlocks: z.array(
    z.object({ type: z.literal('text'), text: z.string() }),
  ),
  metadata: z.record(z.unknown()).nullable(),
  payload: z.record(z.unknown()),
  logicalEventId: z.string().optional(),
  text: z.string().optional(),
});

type ChunkListener = (event: AcpMessage) => void;

/**
 * One subscriber connection per process, shared by every open session
 * stream: a Redis connection in subscriber mode can do nothing else, so the
 * channels multiplex over it instead of each stream holding its own.
 */
let subscriber: Redis | null = null;
const listenersByChannel = new Map<string, Set<ChunkListener>>();

function getSubscriber(): Redis {
  if (subscriber) return subscriber;
  const connection = getRedis().duplicate();
  connection.on('message', (channel: string, raw: string) => {
    const listeners = listenersByChannel.get(channel);
    if (!listeners?.size) return;
    const event = parseFastSessionReplyChunkEvent(raw);
    if (!event) return;
    for (const listener of listeners) listener(event);
  });
  connection.on('error', () => {
    // ioredis reconnects and resubscribes on its own; chunks missed
    // meanwhile are covered by the persisted rows.
  });
  subscriber = connection;
  return connection;
}

/**
 * Live reply text for a Fast session, published by the turn while the model
 * is still writing as `assistant_message_chunk` events (the same envelope
 * the task runtime streams). Best effort: without Redis the transcript still
 * fills in from the persisted rows.
 */
export async function subscribeFastSessionReplyStream(
  sessionId: string,
  onChunk: ChunkListener,
): Promise<{ close: () => Promise<void> }> {
  const channel = getFastAgentReplyStreamChannel(sessionId);
  let subscribed = false;
  try {
    const connection = getSubscriber();
    const listeners = listenersByChannel.get(channel) ?? new Set();
    listenersByChannel.set(channel, listeners);
    if (listeners.size === 0) {
      await connection.subscribe(channel);
    }
    listeners.add(onChunk);
    subscribed = true;
  } catch (error) {
    console.warn(
      `[sessions] Reply streaming is unavailable for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    close: async () => {
      if (!subscribed) return;
      subscribed = false;
      const listeners = listenersByChannel.get(channel);
      listeners?.delete(onChunk);
      if (listeners?.size === 0) {
        listenersByChannel.delete(channel);
        await subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    },
  };
}

export function parseFastSessionReplyChunkEvent(
  raw: string,
): AcpMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const event = replyChunkEventSchema.safeParse(parsed);
  if (!event.success) return undefined;
  return {
    ...event.data,
    kind: inferAcpMessageKind(event.data.eventType),
  };
}

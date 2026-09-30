import {
  db,
  fastAgentConversations,
  fastAgentMessages,
  userFactory,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import {
  FAST_SESSION_TRANSCRIPT_INITIAL_LIMIT,
  getFastSessionById,
} from './fast-sessions';

describe('synthetic long Fast transcript performance', () => {
  it('measures initial query and serialized payload cost for 1,200 messages', async () => {
    const user = await userFactory.create();
    const [session] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: 'synthetic-long-transcript',
        conversationId: `synthetic-long-transcript-${crypto.randomUUID()}`,
        compatibilityMessages: [],
      })
      .returning();
    if (!session) throw new Error('Failed to create synthetic session');

    const startAt = Date.now() - 1_200;
    const body = 'synthetic transcript paragraph '.repeat(16);
    await db.insert(fastAgentMessages).values(
      Array.from({ length: 1_200 }, (_, index) => ({
        conversationId: session.id,
        eventId: `synthetic-long-transcript-${index}`,
        turnId: `turn-${index}`,
        turnSeq: index,
        ts: startAt + index,
        createdAt: new Date(startAt + index),
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant' as const,
        contentBlocks: [{ type: 'text' as const, text: `${index} ${body}` }],
        metadata: { visibleInTranscript: true },
        payload: {},
        source: 'web',
      })),
    );

    const startedAt = performance.now();
    const detail = await getFastSessionById(
      { userId: user.id, isAdmin: false },
      session.id,
      { transcriptLimit: FAST_SESSION_TRANSCRIPT_INITIAL_LIMIT },
    );
    const detailLoadMs = performance.now() - startedAt;
    const serializationStartedAt = performance.now();
    const serialized = JSON.stringify(detail?.messages ?? []);
    const serializationMs = performance.now() - serializationStartedAt;

    console.info(
      '[synthetic-long-transcript-page]',
      JSON.stringify({
        datasetMessages: 1_200,
        hydratedMessages: detail?.messages.length ?? 0,
        detailLoadMs: Number(detailLoadMs.toFixed(2)),
        serializationMs: Number(serializationMs.toFixed(2)),
        serializedBytes: Buffer.byteLength(serialized),
      }),
    );

    expect(detail?.messages).toHaveLength(
      FAST_SESSION_TRANSCRIPT_INITIAL_LIMIT,
    );
    expect(detail?.hasOlderMessages).toBe(true);
  });
});

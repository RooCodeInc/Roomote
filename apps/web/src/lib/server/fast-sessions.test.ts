import {
  db,
  fastAgentConversations,
  fastAgentMessages,
  userFactory,
} from '@roomote/db/server';

import { getFastSessionById, getFastSessions } from './fast-sessions';

async function createFastSession({
  userId,
  conversationId,
  updatedAt,
}: {
  userId: string;
  conversationId: string;
  updatedAt: Date;
}) {
  const [session] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface: 'slack',
      workspaceId: `workspace-${conversationId}`,
      conversationId,
      compatibilityMessages: [{ role: 'user', content: 'Hello' }],
      updatedAt,
    })
    .returning();

  return session!;
}

async function createFastMessage({
  conversationId,
  eventId,
  turnSeq,
  ts = 1,
  eventType = 'roomote_runtime.assistant_message',
  role = 'assistant',
  payload = {},
}: {
  conversationId: string;
  eventId: string;
  turnSeq: number;
  ts?: number;
  eventType?: `roomote_runtime.${string}`;
  role?: 'user' | 'assistant' | 'tool';
  payload?: Record<string, unknown>;
}) {
  const [message] = await db
    .insert(fastAgentMessages)
    .values({
      conversationId,
      eventId,
      turnId: 'turn-1',
      turnSeq,
      ts,
      eventType,
      role,
      contentBlocks: [{ type: 'text', text: eventId }],
      metadata: { visibleInTranscript: true },
      payload,
      source: 'slack',
    })
    .returning();

  return message!;
}

describe('Fast session queries', () => {
  it('lists only the current user sessions for a non-admin', async () => {
    const owner = await userFactory.create();
    const otherUser = await userFactory.create();
    const older = await createFastSession({
      userId: owner.id,
      conversationId: 'older',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await createFastSession({
      userId: owner.id,
      conversationId: 'newer',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: newer.id,
      eventId: 'newer:user',
      turnSeq: 0,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
    });
    await createFastSession({
      userId: otherUser.id,
      conversationId: 'other-user',
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    });

    const sessions = await getFastSessions({
      userId: owner.id,
      isAdmin: false,
    });

    expect(sessions.map((session) => session.id)).toEqual([newer.id, older.id]);
    expect(sessions[0]).toMatchObject({
      messageCount: 1,
      ownerName: owner.name,
    });
  });

  it('lists sessions across users for an admin', async () => {
    const admin = await userFactory.create();
    const otherUser = await userFactory.create();
    const adminSession = await createFastSession({
      userId: admin.id,
      conversationId: 'admin-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const otherSession = await createFastSession({
      userId: otherUser.id,
      conversationId: 'other-session',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const sessions = await getFastSessions({
      userId: admin.id,
      isAdmin: true,
    });

    expect(sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([adminSession.id, otherSession.id]),
    );
  });

  it('applies the same scope to detail lookups', async () => {
    const owner = await userFactory.create();
    const otherUser = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'private-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      getFastSessionById({ userId: otherUser.id, isAdmin: false }, session.id),
    ).resolves.toBeNull();
    await expect(
      getFastSessionById({ userId: otherUser.id, isAdmin: true }, session.id),
    ).resolves.toMatchObject({ id: session.id, userId: owner.id });
  });

  it('reads canonical messages in timestamp and turn sequence order', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'ordered-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:0',
      turnSeq: 1,
      ts: 100,
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      ts: 100,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.messages.map((message) => message.eventId)).toEqual([
      'turn-1:user',
      'turn-1:assistant:0',
    ]);
  });

  it('does not fall back to compatibility messages for existing sessions', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'legacy-only-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(session.compatibilityMessages).toHaveLength(1);
    expect(result?.messages).toEqual([]);
    expect(result?.messageCount).toBe(0);
  });

  it('returns native tool event payloads unchanged', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'native-tool-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:tool-result:0',
      turnSeq: 2,
      eventType: 'roomote_runtime.tool_result',
      role: 'tool',
      payload: {
        toolCallId: 'turn-1:tool:0',
        toolName: 'send_chat_reply',
        status: 'completed',
        output: '{"delivered":true}',
      },
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.messages[0]?.payload).toMatchObject({
      toolCallId: 'turn-1:tool:0',
      toolName: 'send_chat_reply',
      status: 'completed',
    });
  });
});

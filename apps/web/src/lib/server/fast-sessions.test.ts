import {
  db,
  ensureAutomationRowsOnce,
  fastAgentConversations,
  fastAgentMessages,
  userFactory,
} from '@roomote/db/server';

import {
  encodeFastSessionCursor,
  findAccessibleFastSession,
  getFastSessionById,
  getFastSessionMessagesSince,
  getFastSessions,
} from './fast-sessions';

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
  metadata = { visibleInTranscript: true },
}: {
  conversationId: string;
  eventId: string;
  turnSeq: number;
  ts?: number;
  eventType?: `roomote_runtime.${string}`;
  role?: 'user' | 'assistant' | 'tool';
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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
      metadata,
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

    const { sessions, nextCursor } = await getFastSessions({
      userId: owner.id,
      isAdmin: false,
    });

    expect(sessions.map((session) => session.id)).toEqual([newer.id, older.id]);
    expect(sessions[0]).toMatchObject({
      messageCount: 1,
      ownerName: owner.name,
    });
    expect(nextCursor).toBeNull();
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

    const { sessions } = await getFastSessions({
      userId: admin.id,
      isAdmin: true,
    });

    expect(sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([adminSession.id, otherSession.id]),
    );
  });

  it('shows staged automation-owned sessions only to admins', async () => {
    const admin = await userFactory.create();
    const member = await userFactory.create();
    await ensureAutomationRowsOnce();
    const [automationSession] = await db
      .insert(fastAgentConversations)
      .values({
        userId: null,
        ownerAutomation: 'announcer',
        surface: 'automation',
        workspaceId: 'announcer',
        conversationId: 'staged-announcer-session',
      })
      .returning();

    const memberSessions = await getFastSessions({
      userId: member.id,
      isAdmin: false,
    });
    expect(memberSessions.sessions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: automationSession!.id }),
      ]),
    );
    await expect(
      getFastSessionById(
        { userId: member.id, isAdmin: false },
        automationSession!.id,
      ),
    ).resolves.toBeNull();
    await expect(
      getFastSessionById(
        { userId: admin.id, isAdmin: true },
        automationSession!.id,
      ),
    ).resolves.toMatchObject({
      id: automationSession!.id,
      userId: null,
      ownerAutomation: 'announcer',
      ownerName: null,
    });
  });

  it('pages older sessions with a keyset cursor', async () => {
    const owner = await userFactory.create();
    const oldest = await createFastSession({
      userId: owner.id,
      conversationId: 'cursor-oldest',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const middle = await createFastSession({
      userId: owner.id,
      conversationId: 'cursor-middle',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    await createFastSession({
      userId: owner.id,
      conversationId: 'cursor-newest',
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    });

    const { sessions } = await getFastSessions(
      { userId: owner.id, isAdmin: false },
      { before: encodeFastSessionCursor(middle) },
    );

    expect(sessions.map((session) => session.id)).toEqual([oldest.id]);
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

  it('grants participants access to shared conversations they spoke in', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'shared-thread',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: true, userId: participant.id },
    });

    const participantAuth = { userId: participant.id, isAdmin: false };
    await expect(
      getFastSessionById(participantAuth, session.id),
    ).resolves.toMatchObject({ id: session.id });
    const { sessions: participantList } =
      await getFastSessions(participantAuth);
    expect(participantList.map((row) => row.id)).toContain(session.id);

    await expect(
      getFastSessionById({ userId: bystander.id, isAdmin: false }, session.id),
    ).resolves.toBeNull();
  });

  it('excludes transcript-hidden messages such as platform-event prompts', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'platform-event-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: false, turnSource: 'platform_event' },
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:0',
      turnSeq: 1,
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.messages.map((message) => message.eventId)).toEqual([
      'turn-1:assistant:0',
    ]);
  });

  it('truncates oversized tool output at the read boundary', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'oversized-output-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const oversized = 'x'.repeat(30_000);
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
        output: oversized,
      },
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    const payload = result?.messages[0]?.payload as Record<string, unknown>;
    expect((payload.output as string).length).toBeLessThan(oversized.length);
    expect(payload.output).toContain('[output truncated');
  });

  it('windows long transcripts to whole turns and flags older messages', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'long-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // 101 turns x 10 events = 1010 rows; the newest 1000 land mid-turn.
    const rows = Array.from({ length: 1010 }, (_, index) => ({
      conversationId: session.id,
      eventId: `event-${index}`,
      turnId: `turn-${Math.floor(index / 10)}`,
      turnSeq: index % 10,
      ts: index + 1,
      eventType: 'roomote_runtime.assistant_message' as const,
      role: 'assistant' as const,
      contentBlocks: [{ type: 'text' as const, text: `event-${index}` }],
      metadata: { visibleInTranscript: true },
      payload: {},
      source: 'slack',
    }));
    await db.insert(fastAgentMessages).values(rows);

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.hasOlderMessages).toBe(true);
    expect(result?.messages.length).toBeLessThanOrEqual(1000);
    // The oldest included message starts its turn.
    expect(result?.messages[0]?.turnSeq).toBe(0);
    // The newest messages are the ones kept.
    expect(result?.messages.at(-1)?.eventId).toBe('event-1009');
  });

  it('streams only rows updated after the cursor and advances it', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'stream-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      ts: 1,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:hidden',
      turnSeq: 1,
      ts: 2,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: false },
    });

    const first = await getFastSessionMessagesSince(session.id, 0);
    expect(first.messages.map((message) => message.eventId)).toEqual([
      'turn-1:user',
    ]);
    expect(first.cursor).toBeGreaterThan(0);

    const second = await getFastSessionMessagesSince(session.id, first.cursor);
    expect(second.messages).toEqual([]);

    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:0',
      turnSeq: 2,
      ts: 3,
    });
    const third = await getFastSessionMessagesSince(session.id, first.cursor);
    expect(third.messages.map((message) => message.eventId)).toEqual([
      'turn-1:assistant:0',
    ]);
  });

  it('finds sessions for owners and participants but not bystanders', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'access-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: true, userId: participant.id },
    });

    await expect(
      findAccessibleFastSession(
        { userId: owner.id, isAdmin: false },
        session.id,
      ),
    ).resolves.toMatchObject({ id: session.id, surface: 'slack' });
    await expect(
      findAccessibleFastSession(
        { userId: participant.id, isAdmin: false },
        session.id,
      ),
    ).resolves.toMatchObject({ id: session.id });
    await expect(
      findAccessibleFastSession(
        { userId: bystander.id, isAdmin: false },
        session.id,
      ),
    ).resolves.toBeNull();
  });

  it('keeps a partial newest turn when a single turn overflows the window', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'giant-turn-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // One turn with more visible events than the transcript window holds.
    const rows = Array.from({ length: 1010 }, (_, index) => ({
      conversationId: session.id,
      eventId: `event-${index}`,
      turnId: 'turn-0',
      turnSeq: index,
      ts: index + 1,
      eventType: 'roomote_runtime.assistant_message' as const,
      role: 'assistant' as const,
      contentBlocks: [{ type: 'text' as const, text: `event-${index}` }],
      metadata: { visibleInTranscript: true },
      payload: {},
      source: 'slack',
    }));
    await db.insert(fastAgentMessages).values(rows);

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.hasOlderMessages).toBe(true);
    // The whole-turn trim must not empty the window; the newest events stay.
    expect(result?.messages.length).toBe(1000);
    expect(result?.messages.at(-1)?.eventId).toBe('event-1009');
  });
});

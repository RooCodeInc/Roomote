import {
  db,
  ensureSessionForFastConversation,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  llmUsageEvents,
  runFactory,
  sessions,
  taskFactory,
  userFactory,
} from '@roomote/db/server';

import {
  findAccessibleFastSession,
  getFastSessionPrReviewOfferStatus,
  getFastSessionById,
  getFastSessionTasks,
  getFastSessionMessagesSince,
  getFastSessionDisplayTitle,
  updateFastSessionPrReviewOfferStatus,
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
  it('prefers the unified Session title for live Fast updates', async () => {
    const owner = await userFactory.create();
    const conversation = await createFastSession({
      userId: owner.id,
      conversationId: 'unified-display-title',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const session = await ensureSessionForFastConversation(db, conversation.id);
    await db
      .update(sessions)
      .set({
        title: 'Manual unified title',
        titleEditedByUserAt: new Date(),
      })
      .where(eq(sessions.id, session.id));
    await db
      .update(fastAgentConversations)
      .set({ title: 'Generated conversation title' })
      .where(eq(fastAgentConversations.id, conversation.id));

    await expect(
      getFastSessionDisplayTitle(
        conversation.id,
        'Generated conversation title',
      ),
    ).resolves.toBe('Manual unified title');
  });

  it('applies the caller scope to detail lookups', async () => {
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

  it('lists every task associated with a Fast session', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'tasks-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const delegatedTask = await taskFactory.create({
      title: 'Delegated task',
      state: 'active',
    });
    await runFactory.create({
      taskId: delegatedTask.id,
      payload: {
        repo: 'acme/widgets',
        description: 'Delegated Fast task',
        fastAgentSessionId: session.id,
      },
    });
    const zeroCostTask = await taskFactory.create({
      title: 'Zero cost task',
      state: 'active',
    });
    await runFactory.create({
      taskId: zeroCostTask.id,
      payload: {
        repo: 'acme/widgets',
        description: 'Another delegated Fast task',
        fastAgentSessionId: session.id,
      },
    });
    await db.insert(llmUsageEvents).values({
      eventKey: `fast-task-cost-${crypto.randomUUID()}`,
      taskId: delegatedTask.id,
      costSource: 'missing',
      costMicroUsd: 750_000,
    });

    const result = await getFastSessionTasks(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        {
          taskId: delegatedTask.id,
          title: 'Delegated task',
          inferenceCostMicroUsd: 750_000,
        },
        {
          taskId: zeroCostTask.id,
          title: 'Zero cost task',
          inferenceCostMicroUsd: 0,
        },
      ]),
    );
  });

  it('keeps task-linked usage out of the legacy Fast direct cost', async () => {
    const owner = await userFactory.create();
    const nativeSessionId = `native-${crypto.randomUUID()}`;
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'direct-cost-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await db
      .update(fastAgentConversations)
      .set({ openCodeSessionId: nativeSessionId })
      .where(eq(fastAgentConversations.id, session.id));
    const task = await taskFactory.create({ title: 'Delegated task' });
    await runFactory.create({
      taskId: task.id,
      payload: {
        repo: 'acme/widgets',
        description: 'Delegated Fast task',
        fastAgentSessionId: session.id,
      },
    });
    await db.insert(llmUsageEvents).values([
      {
        eventKey: `fast-direct-${crypto.randomUUID()}`,
        harnessSessionId: nativeSessionId,
        messageId: `message-${crypto.randomUUID()}`,
        costSource: 'missing',
        costMicroUsd: 250_000,
      },
      {
        eventKey: `fast-task-${crypto.randomUUID()}`,
        harnessSessionId: nativeSessionId,
        messageId: `message-${crypto.randomUUID()}`,
        taskId: task.id,
        costSource: 'missing',
        costMicroUsd: 500_000,
      },
    ]);

    const detail = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );
    const taskCosts = await getFastSessionTasks(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(detail).toMatchObject({
      directInferenceCostMicroUsd: 250_000,
      inferenceCostMicroUsd: 250_000,
    });
    expect(taskCosts).toEqual([
      expect.objectContaining({
        taskId: task.id,
        inferenceCostMicroUsd: 500_000,
      }),
    ]);
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

  it('streams an in-place review offer retirement', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'review-offer-stream',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const deliveryId = '11111111-1111-4111-8111-111111111111';
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:review',
      turnSeq: 1,
      payload: {
        prReviewAction: {
          deliveryId,
          question: 'Resolve these issues?',
          status: 'pending',
        },
      },
    });
    const first = await getFastSessionMessagesSince(session.id, 0);
    await expect(
      getFastSessionPrReviewOfferStatus(session.id, deliveryId),
    ).resolves.toBe('pending');

    await updateFastSessionPrReviewOfferStatus(
      session.id,
      [deliveryId],
      'dismissed',
    );
    const second = await getFastSessionMessagesSince(session.id, first.cursor);

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.payload).toMatchObject({
      prReviewAction: { deliveryId, status: 'dismissed' },
    });
    await expect(
      getFastSessionPrReviewOfferStatus(session.id, deliveryId),
    ).resolves.toBe('dismissed');
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

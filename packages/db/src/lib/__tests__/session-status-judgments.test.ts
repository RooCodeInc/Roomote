import {
  claimSessionStatusJudgmentRequests,
  clearManualStatusAfterNewerUserMessage,
  completeSessionStatusJudgment,
  createSessionStatusJudgmentRequest,
  db,
  eq,
  enqueueInactiveSessionStatusJudgmentRequests,
  fastAgentConversations,
  fastAgentMessages,
  pruneSessionStatusJudgmentHistory,
  refreshSessionInactivityDueAt,
  sessionFactory,
  sessionStatusJudgments,
  sessions,
  settleSessionStatusJudgmentTurn,
  userFactory,
  users,
} from '../../server';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

const sessionIds: string[] = [];
const userIds: string[] = [];
const conversationIds: string[] = [];

afterEach(async () => {
  while (sessionIds.length > 0) {
    await db.delete(sessions).where(eq(sessions.id, sessionIds.pop()!));
  }
  while (conversationIds.length > 0) {
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversationIds.pop()!));
  }
  while (userIds.length > 0) {
    await db.delete(users).where(eq(users.id, userIds.pop()!));
  }
});

async function createSession() {
  const session = await sessionFactory.create({ cachedStatus: 'ready' });
  sessionIds.push(session.id);
  return session;
}

describe('Session status judgment requests', () => {
  it('deduplicates source events and marks an older generation stale', async () => {
    const session = await createSession();
    const first = await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-1',
      sourceKind: 'fast_turn',
      state: 'pending',
    });
    const replay = await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-1',
      sourceKind: 'fast_turn',
      state: 'pending',
    });

    expect(replay?.id).toBe(first?.id);
    expect(replay?.generation).toBe(first?.generation);

    const second = await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-2',
      sourceKind: 'fast_turn',
      state: 'awaiting_settlement',
    });
    expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);

    const rows = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id))
      .orderBy(sessionStatusJudgments.generation);
    expect(rows.map((row) => row.state)).toEqual([
      'stale',
      'awaiting_settlement',
    ]);

    const [updated] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(updated?.cachedStatus).toBe('ready');
  });

  it('claims only settled current requests and rejects an old model response', async () => {
    const session = await createSession();
    const first = await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-1',
      sourceKind: 'fast_turn',
      state: 'awaiting_settlement',
    });

    expect(
      await claimSessionStatusJudgmentRequests(db, 10, {
        sessionIds: [session.id],
      }),
    ).toEqual([]);
    await settleSessionStatusJudgmentTurn(db, {
      sessionId: session.id,
      sourceEventId: 'turn-1',
      visible: true,
    });
    const [claimed] = await claimSessionStatusJudgmentRequests(db, 10, {
      sessionIds: [session.id],
    });
    expect(claimed).toEqual(
      expect.objectContaining({
        id: first?.id,
        state: 'processing',
        attempts: 1,
      }),
    );

    await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-2',
      sourceKind: 'fast_turn',
      state: 'awaiting_settlement',
    });
    await expect(
      completeSessionStatusJudgment(db, {
        id: claimed!.id,
        sessionId: session.id,
        generation: claimed!.generation,
        state: 'applied',
        outcome: 'done',
        confidence: 0.98,
        probabilities: { done: 0.99 },
      }),
    ).resolves.toBe('stale');

    const [updated] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(updated?.cachedStatus).toBe('ready');
  });

  it('queues one inactivity request after the latest visible user message crosses the boundary', async () => {
    const user = await userFactory.create();
    userIds.push(user.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    conversationIds.push(conversation!.id);
    const session = await sessionFactory.create({
      fastConversationId: conversation!.id,
    });
    sessionIds.push(session.id);
    const latestVisibleUserTs = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    await db.insert(fastAgentMessages).values([
      {
        conversationId: conversation!.id,
        eventId: 'inactivity-visible-user',
        turnId: 'inactivity-visible-turn',
        turnSeq: 1,
        ts: latestVisibleUserTs,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Please investigate this.' }],
        metadata: { visibleInTranscript: true, userId: user.id },
      },
      {
        conversationId: conversation!.id,
        eventId: 'inactivity-hidden-user',
        turnId: 'inactivity-hidden-turn',
        turnSeq: 2,
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hidden later message' }],
        metadata: { visibleInTranscript: false, userId: user.id },
      },
    ]);
    await refreshSessionInactivityDueAt(db, session.id);

    await expect(
      enqueueInactiveSessionStatusJudgmentRequests(db),
    ).resolves.toBe(1);
    await expect(
      enqueueInactiveSessionStatusJudgmentRequests(db),
    ).resolves.toBe(0);

    const [request] = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id));
    expect(request).toMatchObject({
      sourceEventId: `inactivity-due:${latestVisibleUserTs + 4 * 24 * 60 * 60 * 1_000}`,
      sourceKind: 'fast_turn',
      state: 'pending',
    });
  });

  it('clears a manual status when a newer visible user message exists', async () => {
    const user = await userFactory.create();
    userIds.push(user.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    conversationIds.push(conversation!.id);
    const manualStatusSetAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1_000);
    const session = await sessionFactory.create({
      fastConversationId: conversation!.id,
      cachedStatus: 'blocked',
      manualStatus: 'blocked',
      manualStatusSetAt,
    });
    sessionIds.push(session.id);
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'manual-status-newer-user',
      turnId: 'manual-status-newer-turn',
      turnSeq: 1,
      ts: Date.now() - 5 * 24 * 60 * 60 * 1_000,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'Continue automatically.' }],
      metadata: { visibleInTranscript: true, userId: user.id },
    });

    await refreshSessionInactivityDueAt(db, session.id);
    await expect(
      enqueueInactiveSessionStatusJudgmentRequests(db),
    ).resolves.toBe(0);

    await clearManualStatusAfterNewerUserMessage(db, session.id);

    const [updated] = await db
      .select({
        cachedStatus: sessions.cachedStatus,
        manualStatus: sessions.manualStatus,
        manualStatusSetAt: sessions.manualStatusSetAt,
      })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(updated).toEqual({
      cachedStatus: null,
      manualStatus: null,
      manualStatusSetAt: null,
    });

    await refreshSessionInactivityDueAt(db, session.id);
    await expect(
      enqueueInactiveSessionStatusJudgmentRequests(db),
    ).resolves.toBe(1);
  });

  it('completes a result without a deployment experiment gate', async () => {
    const session = await createSession();
    const [request] = await db
      .insert(sessionStatusJudgments)
      .values({
        sessionId: session.id,
        sourceEventId: 'turn-1',
        generation: 1,
        sourceKind: 'fast_turn',
        state: 'processing',
        attempts: 1,
      })
      .returning();

    await expect(
      completeSessionStatusJudgment(db, {
        id: request!.id,
        sessionId: session.id,
        generation: 1,
        state: 'applied',
        outcome: 'done',
        confidence: 0.99,
        probabilities: { done: 1 },
      }),
    ).resolves.toBe('applied');

    const [updatedRequest] = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.id, request!.id));
    expect(updatedRequest).toMatchObject({
      state: 'applied',
      outcome: 'done',
    });
  });

  it('prunes old terminal history while retaining the latest board projection', async () => {
    const session = await createSession();
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await db.insert(sessionStatusJudgments).values([
      {
        sessionId: session.id,
        sourceEventId: 'old-turn',
        generation: 1,
        sourceKind: 'fast_turn',
        state: 'ignored',
        createdAt: oldDate,
        updatedAt: oldDate,
      },
      {
        sessionId: session.id,
        sourceEventId: 'current-turn',
        generation: 2,
        sourceKind: 'fast_turn',
        state: 'applied',
        outcome: 'done',
        confidence: 0.98,
      },
    ]);

    await expect(pruneSessionStatusJudgmentHistory(db)).resolves.toBe(1);
    const retained = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id));
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      sourceEventId: 'current-turn',
      outcome: 'done',
    });
  });
});

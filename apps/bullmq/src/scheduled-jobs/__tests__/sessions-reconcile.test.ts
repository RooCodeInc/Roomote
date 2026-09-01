const mocks = vi.hoisted(() => ({
  enqueueFastAgentParentEvent: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueFastAgentParentEvent,
}));

import {
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  inArray,
  sessionBackfillState,
  sessionFactory,
  sessionTasks,
  sessions,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { sessionsReconcileJob } from '../sessions-reconcile';

const BACKFILL_KEY = 'unified-sessions-v1';

describe('sessionsReconcileJob', () => {
  beforeEach(() => {
    mocks.enqueueFastAgentParentEvent.mockResolvedValue({
      eventKey: 'retry-recovery-event',
      queued: true,
    });
  });

  it('backfills Fast conversations and visible tasks idempotently', async () => {
    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const task = await taskFactory.create({ initiatorUserId: user.id });

    await sessionsReconcileJob();
    await sessionsReconcileJob();

    await expect(
      db
        .select()
        .from(sessions)
        .where(eq(sessions.fastConversationId, conversation!.id)),
    ).resolves.toHaveLength(1);
    await expect(
      db.select().from(sessionTasks).where(eq(sessionTasks.taskId, task.id)),
    ).resolves.toHaveLength(1);
  });

  it('adopts orphan Fast conversations during steady-state reconciliation', async () => {
    // Complete (or advance) the one-time backfill first so the next run takes
    // the steady-state reconciliation path.
    await sessionsReconcileJob();
    await sessionsReconcileJob();

    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();

    await sessionsReconcileJob();

    await expect(
      db
        .select()
        .from(sessions)
        .where(eq(sessions.fastConversationId, conversation!.id)),
    ).resolves.toHaveLength(1);
  });

  it('resumes a backfill parked in the legacy fast_tasks phase', async () => {
    await db
      .insert(sessionBackfillState)
      .values({ key: BACKFILL_KEY, phase: 'fast_tasks' })
      .onConflictDoUpdate({
        target: sessionBackfillState.key,
        set: {
          phase: 'fast_tasks',
          cursorCreatedAt: null,
          cursorId: null,
          completedAt: null,
        },
      });
    const user = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: user.id });

    await sessionsReconcileJob();
    await sessionsReconcileJob();

    await expect(
      db.select().from(sessionTasks).where(eq(sessionTasks.taskId, task.id)),
    ).resolves.toHaveLength(1);
    const state = await db.query.sessionBackfillState.findFirst({
      where: eq(sessionBackfillState.key, BACKFILL_KEY),
    });
    expect(state?.completedAt).not.toBeNull();
  });

  it('continues past a poisoned row during steady-state reconciliation', async () => {
    // Ensure the backfill is complete so the steady-state path runs.
    await sessionsReconcileJob();
    await sessionsReconcileJob();

    const user = await userFactory.create();
    // A surface value the sessions check constraint rejects makes
    // ensureSessionForFastConversation throw for this row only.
    const [poisoned] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'bogus' as never,
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const [healthy] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();

    await expect(sessionsReconcileJob()).resolves.toBeUndefined();

    await expect(
      db
        .select()
        .from(sessions)
        .where(eq(sessions.fastConversationId, healthy!.id)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(sessions)
        .where(eq(sessions.fastConversationId, poisoned!.id)),
    ).resolves.toHaveLength(0);

    // A failed adoption must NOT advance the reconcile watermark, so the
    // failed row stays inside the next run's scan window instead of being
    // stranded past the cutoff once the failure clears.
    const watermarkBefore = await db.query.sessionBackfillState.findFirst({
      where: eq(sessionBackfillState.key, 'unified-sessions-reconcile-v1'),
    });
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, poisoned!.id));
    await sessionsReconcileJob();
    const watermarkAfter = await db.query.sessionBackfillState.findFirst({
      where: eq(sessionBackfillState.key, 'unified-sessions-reconcile-v1'),
    });
    expect(watermarkAfter?.cursorCreatedAt?.getTime() ?? 0).toBeGreaterThan(
      watermarkBefore?.cursorCreatedAt?.getTime() ?? 0,
    );
  });

  it('drains an over-batch orphan backlog across runs without stranding rows', async () => {
    await sessionsReconcileJob();
    await sessionsReconcileJob();

    // 101 orphans: one full batch plus one. A full batch must NOT advance
    // the watermark, so the next run still sees (and adopts) the remainder.
    const user = await userFactory.create();
    const rows = await db
      .insert(fastAgentConversations)
      .values(
        Array.from({ length: 101 }, () => ({
          userId: user.id,
          surface: 'web' as const,
          workspaceId: user.id,
          conversationId: crypto.randomUUID(),
        })),
      )
      .returning({ id: fastAgentConversations.id });

    await sessionsReconcileJob();
    await sessionsReconcileJob();

    const ids = rows.map((row) => row.id);
    const adopted = await db
      .select({ id: sessions.fastConversationId })
      .from(sessions)
      .where(inArray(sessions.fastConversationId, ids));
    expect(adopted).toHaveLength(101);
  });

  it('heals sessions wedged active on an expired responding lease', async () => {
    await sessionsReconcileJob();
    await sessionsReconcileJob();

    const wedged = await sessionFactory.create({
      cachedStatus: 'active',
      respondingUntil: new Date(Date.now() - 60_000),
      // Old activity keeps it clear of the recent-activity refresh window.
      activityAt: 100,
    });

    await sessionsReconcileJob();

    const [healed] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, wedged.id));
    expect(healed?.cachedStatus).toBe('ready');

    await db.delete(sessions).where(eq(sessions.id, wedged.id));
  });

  it('reconciles persisted retry notices after the responding lease expires', async () => {
    await sessionsReconcileJob();
    await sessionsReconcileJob();

    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    await sessionsReconcileJob();
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'interrupted-turn:retry-notice:0',
      turnId: 'interrupted-turn',
      turnSeq: 1,
      ts: Date.now(),
      eventType: 'roomote_runtime.assistant_message',
      role: 'assistant',
      contentBlocks: [
        {
          type: 'text',
          text: 'The inference provider returned a temporary error. Retrying in 1s (attempt 1/6).',
        },
      ],
      metadata: {
        visibleInTranscript: true,
        purpose: 'progress',
        inferenceRetryNotice: true,
        inferenceRetryActive: true,
      },
      payload: { purpose: 'progress' },
      source: 'web',
    });
    await db
      .update(sessions)
      .set({
        cachedStatus: 'ready',
        respondingUntil: new Date(Date.now() - 60_000),
      })
      .where(eq(sessions.fastConversationId, conversation!.id));

    await sessionsReconcileJob();

    const [notice] = await db
      .select({
        contentBlocks: fastAgentMessages.contentBlocks,
        metadata: fastAgentMessages.metadata,
      })
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, conversation!.id));
    expect(notice?.contentBlocks).toEqual([
      {
        type: 'text',
        text: 'The inference retry was interrupted before it completed. Please send the request again.',
      },
    ]);
    expect(notice?.metadata).toMatchObject({
      purpose: 'closeout',
      inferenceRetryActive: false,
    });
  });

  it('queues a safe expired retry for a new lock owner', async () => {
    await sessionsReconcileJob();
    await sessionsReconcileJob();

    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    await sessionsReconcileJob();
    await db.insert(fastAgentMessages).values([
      {
        conversationId: conversation!.id,
        eventId: 'recoverable-turn:user',
        turnId: 'recoverable-turn',
        turnSeq: 0,
        ts: Date.now(),
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Recover this request.' }],
        metadata: { visibleInTranscript: true, turnSource: 'human' },
        payload: {},
        source: 'web',
      },
      {
        conversationId: conversation!.id,
        eventId: 'recoverable-turn:retry-notice:0',
        turnId: 'recoverable-turn',
        turnSeq: 1,
        ts: Date.now(),
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Retrying automatically…' }],
        metadata: {
          visibleInTranscript: false,
          purpose: 'progress',
          inferenceRetryNotice: true,
          inferenceRetryActive: true,
          inferenceRetryRecoveryEligible: true,
        },
        payload: { purpose: 'progress' },
        source: 'web',
      },
    ]);
    await db
      .update(sessions)
      .set({ respondingUntil: new Date(Date.now() - 60_000) })
      .where(eq(sessions.fastConversationId, conversation!.id));

    await sessionsReconcileJob();
    await sessionsReconcileJob();

    expect(mocks.enqueueFastAgentParentEvent).toHaveBeenCalledWith({
      parent: expect.objectContaining({ sessionId: conversation!.id }),
      event: {
        type: 'inference_retry_resume',
        eventId: 'recoverable-turn:retry-notice:0',
        retryEventId: 'recoverable-turn:retry-notice:0',
      },
    });

    const [notice] = await db
      .select({ metadata: fastAgentMessages.metadata })
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.eventId, 'recoverable-turn:retry-notice:0'));
    expect(notice?.metadata).toMatchObject({
      inferenceRetryActive: true,
      inferenceRetryRecoveryEligible: true,
    });
  });
});

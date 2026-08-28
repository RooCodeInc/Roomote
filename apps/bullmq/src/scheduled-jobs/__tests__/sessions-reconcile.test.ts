import {
  db,
  eq,
  fastAgentConversations,
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
});

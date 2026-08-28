import {
  db,
  eq,
  fastAgentConversations,
  sessionTasks,
  sessions,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { sessionsReconcileJob } from '../sessions-reconcile';

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
});

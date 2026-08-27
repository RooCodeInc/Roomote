import {
  db,
  deploymentSettings,
  eq,
  fastAgentConversations,
  sessionTasks,
  sessions,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { sessionsReconcileJob } from '../sessions-reconcile';

describe('sessionsReconcileJob', () => {
  beforeEach(async () => {
    await db
      .insert(deploymentSettings)
      .values({ id: 'default', metadata: { sessions_data: true } })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: { metadata: { sessions_data: true } },
      });
  });

  afterEach(async () => {
    await db
      .update(deploymentSettings)
      .set({ metadata: {} })
      .where(eq(deploymentSettings.id, 'default'));
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
});

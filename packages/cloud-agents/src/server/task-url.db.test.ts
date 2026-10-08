import {
  db,
  eq,
  ensureAutomationRows,
  ensureSessionForTask,
  fastAgentConversations,
  getSessionForTask,
  sessions,
  taskFactory,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { getTaskSessionUrl } from './task-url';

const taskIds: string[] = [];
const sessionIds: string[] = [];
const conversationIds: string[] = [];
const userIds: string[] = [];
afterEach(async () => {
  for (const id of sessionIds.splice(0))
    await db.delete(sessions).where(eq(sessions.id, id));
  for (const id of taskIds.splice(0))
    await db.delete(tasks).where(eq(tasks.id, id));
  for (const id of conversationIds.splice(0))
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, id));
  for (const id of userIds.splice(0))
    await db.delete(users).where(eq(users.id, id));
});
const utm = { source: 'github-comment', campaign: 'standard' };

it.each([false, true])(
  'resolves a real direct session (automation=%s) without a task fallback',
  async (automation) => {
    await ensureAutomationRows(db);
    const task = await taskFactory.create(
      automation
        ? {
            visibility: 'hidden',
            initiatorKind: 'automation',
            initiatorUserId: null,
            initiatorAutomation: 'slack_channel_auto_start',
          }
        : {},
    );
    taskIds.push(task.id);
    const url = await getTaskSessionUrl({ taskId: task.id, utm });
    const session = await getSessionForTask(db, task.id);
    sessionIds.push(session!.id);
    expect(new URL(url).pathname).toBe(`/sessions/${session!.id}`);
    expect(session).toMatchObject(
      automation
        ? {
            ownerKind: 'automation',
            visibility: 'hidden',
            ownerAutomation: 'slack_channel_auto_start',
          }
        : { visibility: 'visible' },
    );
    expect(
      await getTaskSessionUrl({
        taskId: task.id,
        fastConversationId: crypto.randomUUID(),
        utm,
      }),
    ).toBe(url);
  },
);

it('selects the canonical delegated parent even with a stale payload hint', async () => {
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
  const task = await taskFactory.create({ initiatorUserId: user.id });
  taskIds.push(task.id);
  const session = await ensureSessionForTask(db, {
    taskId: task.id,
    fastConversationId: conversation!.id,
    origin: 'fast_delegation',
  });
  sessionIds.push(session.id);
  const url = await getTaskSessionUrl({
    taskId: task.id,
    fastConversationId: crypto.randomUUID(),
    utm,
  });
  expect(new URL(url).pathname).toBe(`/sessions/${session.id}`);
  expect(session.fastConversationId).toBe(conversation!.id);
});

it('fails rather than inventing an origin URL for a missing task', async () => {
  await expect(
    getTaskSessionUrl({ taskId: 'missing-origin-task', utm }),
  ).rejects.toThrow('does not exist');
});

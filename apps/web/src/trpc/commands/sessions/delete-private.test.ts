import {
  db,
  eq,
  fastAgentConversations,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  tasks,
  userFactory,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';

import { deletePrivateSessionCommand } from './index';

describe('deletePrivateSessionCommand', () => {
  it('deletes an owned private Session and descendants but denies other users', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        privacy: 'private',
        privateOwnerUserId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
      fastConversationId: conversation!.id,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });

    await expect(
      deletePrivateSessionCommand(
        { userId: other.id, isAdmin: true } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: false });
    await expect(
      deletePrivateSessionCommand(
        { userId: owner.id, isAdmin: false } as UserAuthSuccess,
        session.id,
      ),
    ).resolves.toEqual({ deleted: true });
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.fastAgentConversations.findFirst({
        where: eq(fastAgentConversations.id, conversation!.id),
      }),
    ).resolves.toBeUndefined();
  });
});

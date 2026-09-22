import {
  db,
  eq,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  tasks,
  userFactory,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';
import { appRouter } from './_app';

function auth(userId: string, isAdmin = false) {
  return {
    success: true,
    userType: 'user',
    userId,
    isAdmin,
  } as UserAuthSuccess;
}

describe('private Session procedures', () => {
  it('keeps task lookup, rename, and unarchive owner-only', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
      title: 'Private Session',
      archivedAt: new Date(),
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      archivedAt: session.archivedAt,
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });

    const ownerCaller = appRouter.createCaller({ auth: auth(owner.id) });
    await expect(
      ownerCaller.sessions.forTask({ taskId: task.id }),
    ).resolves.toEqual({
      sessionId: session.id,
      title: 'Private Session',
    });

    for (const deniedAuth of [auth(other.id), auth(other.id, true)]) {
      const caller = appRouter.createCaller({ auth: deniedAuth });
      await expect(
        caller.sessions.forTask({ taskId: task.id }),
      ).resolves.toBeNull();
      await expect(
        caller.sessions.rename({ sessionId: session.id, title: 'Exposed' }),
      ).resolves.toBeNull();
      await expect(
        caller.sessions.unarchive({ sessionId: session.id }),
      ).resolves.toBeNull();
    }

    await expect(
      ownerCaller.sessions.rename({
        sessionId: session.id,
        title: 'Owner rename',
      }),
    ).resolves.toMatchObject({ title: 'Owner rename' });
    await expect(
      ownerCaller.sessions.unarchive({ sessionId: session.id }),
    ).resolves.toMatchObject({ archivedAt: null });
    await expect(
      db.query.sessions.findFirst({ where: eq(sessions.id, session.id) }),
    ).resolves.toMatchObject({ title: 'Owner rename', archivedAt: null });
    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }),
    ).resolves.toMatchObject({ archivedAt: null });
  });
});

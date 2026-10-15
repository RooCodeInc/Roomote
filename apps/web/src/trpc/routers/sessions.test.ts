import {
  automations,
  db,
  eq,
  ensureSessionForFastConversation,
  ensureSessionForTask,
  fastAgentConversations,
  inArray,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  tasks,
  userFactory,
  users,
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
  it('excludes automation origins before pagination only when requested', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    await db
      .insert(automations)
      .values({ key: 'suggester' })
      .onConflictDoNothing();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        ownerAutomation: 'suggester',
        surface: 'automation',
        workspaceId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const fastSession = await ensureSessionForFastConversation(
      db,
      conversation!.id,
    );
    const automationTask = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorAutomation: 'suggester',
    });
    const taskSession = await ensureSessionForTask(db, {
      taskId: automationTask.id,
    });
    const humanSessions = await Promise.all(
      [300, 200, 100].map((activityAt) =>
        sessionFactory.create({
          ownerKind: 'user',
          ownerUserId: owner.id,
          title: 'Automation report',
          sourceSurface: 'github',
          sourceTrigger: 'webhook',
          activityAt,
        }),
      ),
    );
    const privateSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: other.id,
      privacy: 'private',
      privateOwnerUserId: other.id,
    });
    // An automation task attached later must not reclassify a human origin.
    const attachedTask = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorAutomation: 'suggester',
    });
    await db.insert(sessionTasks).values({
      sessionId: humanSessions[0]!.id,
      taskId: attachedTask.id,
      origin: 'direct_launch',
    });
    const ids = [
      fastSession.id,
      taskSession.id,
      privateSession.id,
      ...humanSessions.map((s) => s.id),
    ];
    const caller = appRouter.createCaller({ auth: auth(owner.id, true) });
    try {
      expect(fastSession.ownerKind).toBe('automation');
      expect(taskSession.ownerKind).toBe('automation');
      const defaults = await caller.sessions.list({ ids });
      expect(defaults.sessions.map((s) => s.id)).toEqual([
        expect.any(String),
        expect.any(String),
        ...humanSessions.map((s) => s.id),
      ]);
      expect(defaults.sessions.map((s) => s.id)).toEqual(
        expect.arrayContaining([fastSession.id, taskSession.id]),
      );
      expect(
        (
          await caller.sessions.list({ ids, excludeAutomations: false })
        ).sessions.map((s) => s.id),
      ).toEqual(defaults.sessions.map((s) => s.id));

      let before: string | null = null;
      for (const [index, human] of humanSessions.entries()) {
        const page = await caller.sessions.list({
          ids,
          excludeAutomations: true,
          limit: 1,
          before,
        });
        expect(page.sessions.map((s) => s.id)).toEqual([human.id]);
        expect(page.nextCursor === null).toBe(
          index === humanSessions.length - 1,
        );
        before = page.nextCursor;
      }
      const owned = await caller.sessions.list({
        ids,
        ownedOnly: true,
        excludeAutomations: true,
      });
      expect(owned.sessions.map((s) => s.id)).toEqual(
        humanSessions.map((s) => s.id),
      );
      const history = await caller.sessions.list({ ids, scope: 'automations' });
      expect(history.sessions.map((s) => s.id)).toEqual(
        expect.arrayContaining([fastSession.id, taskSession.id]),
      );
    } finally {
      await db.delete(sessions).where(inArray(sessions.id, ids));
      await db
        .delete(tasks)
        .where(inArray(tasks.id, [automationTask.id, attachedTask.id]));
      await db
        .delete(fastAgentConversations)
        .where(eq(fastAgentConversations.id, conversation!.id));
      await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
    }
  });

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

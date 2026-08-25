import {
  db,
  fastAgentConversations,
  runFactory,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

import {
  getFastSessionById,
  getFastSessions,
  normalizeFastSessionTranscript,
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

describe('Fast session queries', () => {
  it('lists only the current user sessions for a non-admin', async () => {
    const owner = await userFactory.create();
    const otherUser = await userFactory.create();
    const older = await createFastSession({
      userId: owner.id,
      conversationId: 'older',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await createFastSession({
      userId: owner.id,
      conversationId: 'newer',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    await createFastSession({
      userId: otherUser.id,
      conversationId: 'other-user',
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    });

    const sessions = await getFastSessions({
      userId: owner.id,
      isAdmin: false,
    });

    expect(sessions.map((session) => session.id)).toEqual([newer.id, older.id]);
    expect(sessions[0]).toMatchObject({
      messageCount: 1,
      ownerName: owner.name,
    });
  });

  it('lists sessions across users for an admin', async () => {
    const admin = await userFactory.create();
    const otherUser = await userFactory.create();
    const adminSession = await createFastSession({
      userId: admin.id,
      conversationId: 'admin-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const otherSession = await createFastSession({
      userId: otherUser.id,
      conversationId: 'other-session',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const sessions = await getFastSessions({
      userId: admin.id,
      isAdmin: true,
    });

    expect(sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([adminSession.id, otherSession.id]),
    );
  });

  it('applies the same scope to detail lookups', async () => {
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

  it('normalizes only persisted user and assistant text', () => {
    expect(
      normalizeFastSessionTranscript([
        { role: 'user', content: [{ type: 'text', text: 'Question' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Answer' },
            { type: 'reasoning', text: 'Unsupported reasoning' },
          ],
        },
        { role: 'tool', content: [{ type: 'text', text: 'Tool output' }] },
      ]),
    ).toEqual([
      { id: 'fast-message-0', role: 'user', text: 'Question' },
      { id: 'fast-message-1', role: 'assistant', text: 'Answer' },
    ]);
  });

  it('returns visible tasks delegated from the Fast session', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'delegated-task-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const task = await taskFactory.create({ title: 'Delegated task' });
    await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      payload: {
        repo: 'roomote/roomote',
        description: 'Delegated task',
        fastAgentSessionId: session.id,
      },
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.linkedTasks).toEqual([
      expect.objectContaining({
        taskId: task.id,
        title: 'Delegated task',
        status: RunStatus.Running,
      }),
    ]);
  });
});

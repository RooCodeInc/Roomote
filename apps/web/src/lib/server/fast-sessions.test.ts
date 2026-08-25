import { db, fastAgentConversations, userFactory } from '@roomote/db/server';

import { getFastSessionById, getFastSessions } from './fast-sessions';

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
});

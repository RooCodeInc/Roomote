import {
  and,
  db,
  eq,
  sessionFactory,
  sessions,
  userFactory,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { getOrCreateSideChatCommand } from './index';

describe('Session side chats', () => {
  it('creates one Fast Session per person and parent', async () => {
    const owner = await userFactory.create();
    const parent = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Main implementation',
    });
    const auth = {
      userId: owner.id,
      isAdmin: false,
    } as UserAuthSuccess;

    const first = await getOrCreateSideChatCommand(auth, parent.id);
    const second = await getOrCreateSideChatCommand(auth, parent.id);

    expect(first).toMatchObject({
      title: 'Side chat: Main implementation',
    });
    expect(second?.sessionId).toBe(first?.sessionId);
    const rows = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.parentSessionId, parent.id),
          eq(sessions.ownerUserId, owner.id),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('does not nest another side chat beneath a side chat', async () => {
    const owner = await userFactory.create();
    const parent = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    const ownerAuth = {
      userId: owner.id,
      isAdmin: false,
    } as UserAuthSuccess;
    const ownerSideChat = await getOrCreateSideChatCommand(
      ownerAuth,
      parent.id,
    );

    await expect(
      getOrCreateSideChatCommand(ownerAuth, ownerSideChat!.sessionId),
    ).resolves.toBeNull();
  });
});

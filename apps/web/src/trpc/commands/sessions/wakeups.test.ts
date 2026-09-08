import {
  db,
  eq,
  fastAgentConversations,
  getSessionWakeupById,
  insertSessionWakeup,
  sessionFactory,
  sessionWakeups,
  userFactory,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';
import {
  cancelSessionWakeupCommand,
  getSessionWakeupsCommand,
} from './wakeups';

vi.mock('@roomote/sdk/server', () => ({
  syncFastAgentSlackTitleBestEffort: vi.fn(),
}));

async function fixture(canonical = true) {
  const owner = await userFactory.create();
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: owner.id,
      surface: 'web',
      workspaceId: owner.id,
      conversationId: crypto.randomUUID(),
    })
    .returning();
  const session = canonical
    ? await sessionFactory.create({
        ownerKind: 'user',
        ownerUserId: owner.id,
        fastConversationId: conversation!.id,
      })
    : null;
  const nextRunAt = new Date(Date.now() + 60_000);
  const wakeup = await insertSessionWakeup({
    conversationId: conversation!.id,
    createdByUserId: owner.id,
    name: 'Reminder',
    prompt: 'Remember to check',
    schedule: { mode: 'once', at: nextRunAt.toISOString() },
    reportPolicy: 'always',
    maxRuns: 1,
    until: null,
    nextRunAt,
  });
  return {
    auth: { userId: owner.id, isAdmin: false } as UserAuthSuccess,
    sessionId: session?.id ?? conversation!.id,
    conversationId: conversation!.id,
    wakeup,
  };
}

describe('Session wakeup commands', () => {
  it('lists active summaries and server time through canonical and Fast IDs', async () => {
    const { auth, sessionId, conversationId, wakeup } = await fixture();
    for (const id of [sessionId, conversationId]) {
      const result = await getSessionWakeupsCommand(auth, id);
      expect(result.canCancel).toBe(true);
      expect(new Date(result.now).toISOString()).toBe(result.now);
      expect(result.wakeups).toEqual([
        expect.objectContaining({ id: wakeup.id, status: 'active' }),
      ]);
    }
  });

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'excludes %s wakeups and preserves terminal cancellation',
    async (status) => {
      const { auth, sessionId, wakeup } = await fixture();
      await db
        .update(sessionWakeups)
        .set({ status })
        .where(eq(sessionWakeups.id, wakeup.id));
      expect((await getSessionWakeupsCommand(auth, sessionId)).wakeups).toEqual(
        [],
      );
      expect(
        await cancelSessionWakeupCommand(auth, {
          sessionId,
          wakeupId: wakeup.id,
        }),
      ).toMatchObject({ outcome: 'already_terminal', wakeup: { status } });
      expect((await getSessionWakeupById(wakeup.id))?.status).toBe(status);
    },
  );

  it.each([true, false])(
    'allows shared reads but denies nonowner cancellation (canonical=%s)',
    async (canonical) => {
      const { auth, sessionId, conversationId, wakeup } =
        await fixture(canonical);
      const stranger = await userFactory.create();
      const sharedAuth = { ...auth, userId: stranger.id };
      for (const id of new Set([sessionId, conversationId])) {
        expect(await getSessionWakeupsCommand(sharedAuth, id)).toMatchObject({
          canCancel: false,
          wakeups: [{ id: wakeup.id }],
        });
        await expect(
          cancelSessionWakeupCommand(sharedAuth, {
            sessionId: id,
            wakeupId: wakeup.id,
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect((await getSessionWakeupById(wakeup.id))?.status).toBe('active');
      expect(
        await cancelSessionWakeupCommand(
          { ...sharedAuth, isAdmin: true },
          { sessionId, wakeupId: wakeup.id },
        ),
      ).toMatchObject({ outcome: 'cancelled' });
      expect((await getSessionWakeupById(wakeup.id))?.status).toBe('cancelled');
    },
  );

  it('cancels as owner through a Fast alias and is idempotent', async () => {
    const { auth, conversationId, wakeup } = await fixture();
    const input = { sessionId: conversationId, wakeupId: wakeup.id };
    expect(await cancelSessionWakeupCommand(auth, input)).toMatchObject({
      outcome: 'cancelled',
    });
    expect(await cancelSessionWakeupCommand(auth, input)).toMatchObject({
      outcome: 'already_terminal',
    });
  });

  it('does not disclose or cancel cross-session wakeup IDs', async () => {
    const own = await fixture();
    const other = await fixture();
    for (const wakeupId of [other.wakeup.id, crypto.randomUUID()]) {
      expect(
        await cancelSessionWakeupCommand(own.auth, {
          sessionId: own.sessionId,
          wakeupId,
        }),
      ).toEqual({ outcome: 'not_found' });
    }
    expect((await getSessionWakeupById(other.wakeup.id))?.status).toBe(
      'active',
    );
  });

  it('returns NOT_FOUND for missing sessions and empty wakeups for task-only sessions', async () => {
    const { auth, wakeup } = await fixture();
    const sessionId = crypto.randomUUID();
    await expect(
      getSessionWakeupsCommand(auth, sessionId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      cancelSessionWakeupCommand(auth, { sessionId, wakeupId: wakeup.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const taskOnly = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: auth.userId,
    });
    expect(await getSessionWakeupsCommand(auth, taskOnly.id)).toMatchObject({
      wakeups: [],
      canCancel: true,
    });
    expect(
      await cancelSessionWakeupCommand(auth, {
        sessionId: taskOnly.id,
        wakeupId: wakeup.id,
      }),
    ).toEqual({ outcome: 'not_found' });
  });

  it('uses canonical ownership instead of Fast ownership when they differ', async () => {
    const { auth, conversationId, wakeup } = await fixture(false);
    const owner = await userFactory.create();
    await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      fastConversationId: conversationId,
    });
    expect(
      (await getSessionWakeupsCommand(auth, conversationId)).canCancel,
    ).toBe(false);
    await expect(
      cancelSessionWakeupCommand(auth, {
        sessionId: conversationId,
        wakeupId: wakeup.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

import {
  db,
  fastAgentConversations,
  sessionFactory,
  userFactory,
} from '@roomote/db/server';
import {
  acquireFastAgentTurnLock,
  fastAgentConversationRepository,
} from '@roomote/cloud-agents/server';
import * as sessionQueries from '@/lib/server/sessions';
import type { UserAuthSuccess } from '@/types';
import { archiveSessionCommand } from './index';

const mocks = vi.hoisted(() => ({
  acquireRedisLock: vi.fn(),
  cancelWakeups: vi.fn(),
}));

vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  acquireRedisLock: mocks.acquireRedisLock,
}));
vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  cancelSessionWakeupsForConversation: mocks.cancelWakeups,
}));
vi.mock('@roomote/sdk/server', () => ({
  syncFastAgentSlackTitleBestEffort: vi.fn(),
}));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));

describe('archiveSessionCommand turn serialization', () => {
  const locks = new Set<string>();
  let contention: ReturnType<typeof Promise.withResolvers<void>>;

  beforeEach(() => {
    locks.clear();
    contention = Promise.withResolvers<void>();
    mocks.cancelWakeups.mockReset().mockResolvedValue(0);
    mocks.acquireRedisLock
      .mockReset()
      .mockImplementation(async (key: string) => {
        if (locks.has(key)) {
          contention.resolve();
          return null;
        }
        locks.add(key);
        return Object.assign(
          async () => {
            locks.delete(key);
          },
          {
            renewDetailed: async () => 'renewed',
          },
        );
      });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(locks.size).toBe(0);
  });

  async function fixture(fast = true) {
    const owner = await userFactory.create();
    const [record] = fast
      ? await db
          .insert(fastAgentConversations)
          .values({
            userId: owner.id,
            surface: 'web',
            workspaceId: owner.id,
            conversationId: crypto.randomUUID(),
          })
          .returning()
      : [];
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      fastConversationId: record?.id ?? null,
    });
    const auth = { userId: owner.id, isAdmin: false } as UserAuthSuccess;
    return { auth, session, record };
  }

  it('cannot commit archive while reply is in flight, then archives after the turn releases', async () => {
    const { auth, session, record } = await fixture();
    const conversation = await fastAgentConversationRepository.findById({
      id: record!.id,
    });
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const turn = await acquireFastAgentTurnLock({
      conversation: conversation!.conversation,
    });
    const reply = Promise.withResolvers<void>();
    const replyFinished = reply.promise.finally(() => turn!());
    const archive = archiveSessionCommand(auth, session.id);
    await contention.promise;
    expect(
      (await sessionQueries.findAccessibleSession(auth, session.id))
        ?.archivedAt,
    ).toBeNull();
    expect(mocks.cancelWakeups).not.toHaveBeenCalled();
    reply.resolve();
    await replyFinished;
    await vi.advanceTimersByTimeAsync(500);
    expect(await archive).toMatchObject({
      id: session.id,
      archivedAt: expect.any(Date),
    });
    expect(
      (await sessionQueries.findAccessibleSession(auth, session.id))
        ?.archivedAt,
    ).toBeInstanceOf(Date);
    expect(mocks.cancelWakeups).toHaveBeenCalledWith(record!.id);
  });

  it('fails retryably without archival when the turn stays busy', async () => {
    const { auth, session, record } = await fixture();
    const conversation = await fastAgentConversationRepository.findById({
      id: record!.id,
    });
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const turn = await acquireFastAgentTurnLock({
      conversation: conversation!.conversation,
    });
    try {
      const result = expect(
        archiveSessionCommand(auth, session.id),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await contention.promise;
      await vi.advanceTimersByTimeAsync(2_000);
      await result;
      expect(
        (await sessionQueries.findAccessibleSession(auth, session.id))
          ?.archivedAt,
      ).toBeNull();
      expect(mocks.cancelWakeups).not.toHaveBeenCalled();
    } finally {
      await turn!();
    }
  });

  it('releases the lock when the metadata update fails', async () => {
    const { auth, session } = await fixture();
    vi.spyOn(sessionQueries, 'updateSessionMetadata').mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(archiveSessionCommand(auth, session.id)).rejects.toThrow(
      'database unavailable',
    );
    expect(
      (await sessionQueries.findAccessibleSession(auth, session.id))
        ?.archivedAt,
    ).toBeNull();
    expect(locks.size).toBe(0);
    expect(await archiveSessionCommand(auth, session.id)).toMatchObject({
      archivedAt: expect.any(Date),
    });
  });

  it('does not archive when lock acquisition fails', async () => {
    const { auth, session } = await fixture();
    mocks.acquireRedisLock.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );
    await expect(archiveSessionCommand(auth, session.id)).rejects.toThrow(
      'redis unavailable',
    );
    expect(
      (await sessionQueries.findAccessibleSession(auth, session.id))
        ?.archivedAt,
    ).toBeNull();
    expect(mocks.cancelWakeups).not.toHaveBeenCalled();
  });

  it('releases the lock and preserves archival if wakeup cancellation fails', async () => {
    const { auth, session } = await fixture();
    mocks.cancelWakeups.mockRejectedValueOnce(new Error('cancel failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await archiveSessionCommand(auth, session.id)).toMatchObject({
      archivedAt: expect.any(Date),
    });
  });

  it('checks archive permission before conversation lookup or locking and preserves missing behavior', async () => {
    const { auth, session } = await fixture();
    const stranger = await userFactory.create();
    const lookup = vi.spyOn(fastAgentConversationRepository, 'findById');
    expect(
      await archiveSessionCommand({ ...auth, userId: stranger.id }, session.id),
    ).toBeNull();
    expect(await archiveSessionCommand(auth, crypto.randomUUID())).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(mocks.acquireRedisLock).not.toHaveBeenCalled();
    expect(
      await archiveSessionCommand(
        { ...auth, userId: stranger.id, isAdmin: true },
        session.id,
      ),
    ).toMatchObject({ archivedAt: expect.any(Date) });
  });

  it('archives task-only sessions without a turn lock', async () => {
    const { auth, session } = await fixture(false);
    expect(await archiveSessionCommand(auth, session.id)).toMatchObject({
      archivedAt: expect.any(Date),
    });
    expect(mocks.acquireRedisLock).not.toHaveBeenCalled();
  });

  it('fails closed if the conversation cannot be resolved', async () => {
    const { auth, session } = await fixture();
    vi.spyOn(fastAgentConversationRepository, 'findById').mockResolvedValueOnce(
      null,
    );
    await expect(archiveSessionCommand(auth, session.id)).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
    expect(
      (await sessionQueries.findAccessibleSession(auth, session.id))
        ?.archivedAt,
    ).toBeNull();
    expect(mocks.acquireRedisLock).not.toHaveBeenCalled();
  });
});

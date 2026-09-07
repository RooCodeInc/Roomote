import {
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
  userFactory,
  users,
} from '@roomote/db/server';
import type { FastAgentHumanFollowUpEvent } from '@roomote/types';
import type { FastAgentTurnLockHandle } from '@roomote/cloud-agents/server';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  deliverTurn: vi.fn(),
  queueAdd: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.queueAdd;
  },
}));
vi.mock('@roomote/redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  FAST_AGENT_DURABLE_TURN_CLAIM_MS: 15 * 60 * 1000,
  findFastAgentDurableRetryScheduledError: () => null,
}));
vi.mock('./fast-agent-parent-event', () => ({
  buildEventClientMessageSeed: (event: FastAgentHumanFollowUpEvent) =>
    `fast-parent-human-follow-up:${event.eventId}`,
  deliverFastAgentParentEventWithLock: mocks.deliverTurn,
  FastAgentParentEventDeliveryError: class extends Error {},
}));
vi.mock('./task-runs/fast-agent-startup-retry', () => ({
  retryFastAgentStartup: vi.fn(),
}));

import { admitFastAgentHumanFollowUp } from './fast-agent-human-follow-up';
import {
  buildFastAgentParentEventKey,
  drainFastAgentParentEvents,
  FastAgentParentBusyError,
} from './fast-agent-parent-event-queue';

it('runs questions admitted during outbound closeout as ordered, exactly-once queued turns', async () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((finish) => {
      resolve = finish;
    });
    return { promise, resolve };
  }
  const user = await userFactory.create();
  const conversation = {
    surface: 'slack' as const,
    workspaceId: 'closeout-queue-test',
    conversationId: crypto.randomUUID(),
    replyTarget: { channelId: 'test-channel', threadId: 'test-thread' },
  };
  const [session] = await db
    .insert(fastAgentConversations)
    .values({
      userId: user.id,
      ...conversation,
    })
    .returning();
  const parent = { sessionId: session!.id, conversation };
  const first: FastAgentHumanFollowUpEvent = {
    type: 'human_follow_up',
    eventId: '100.2',
    currentMessageId: '100.2',
    userId: user.id,
    question: 'First question during the original answer.',
  };
  const later: FastAgentHumanFollowUpEvent = {
    ...first,
    eventId: '100.3',
    currentMessageId: '100.3',
    question: 'Later question.',
  };
  const wakeup = {
    conversationId: parent.sessionId,
    eventKey: buildFastAgentParentEventKey({ parent, event: first }),
  };
  const originalCloseout = deferred();
  const firstCloseout = deferred();
  const firstTurnStarted = deferred();
  let owner: FastAgentTurnLockHandle | undefined;
  mocks.acquireLock.mockImplementation(async () => {
    if (owner) return null;
    const release = Object.assign(
      vi.fn(async () => {
        owner = undefined;
      }),
      {
        signal: new AbortController().signal,
      },
    ) as unknown as FastAgentTurnLockHandle;
    owner = release;
    return release;
  });
  // Exercise real admission and PostgreSQL queue state; substitute only the
  // shared lock and whole-turn executor/outbound transport boundaries.
  const postReply = vi.fn(async (message: string) => {
    if (message === 'Original answer.') await originalCloseout.promise;
    if (message === 'First answer.') await firstCloseout.promise;
  });
  const turns: string[] = [];
  mocks.deliverTurn.mockImplementation(async ({ event }, lock) => {
    expect(owner).toBe(lock);
    expect(lock).not.toBe(oldLock);
    turns.push(event.currentMessageId);
    if (event.currentMessageId === first.currentMessageId) {
      firstTurnStarted.resolve();
      await postReply('First answer.');
    } else {
      await postReply('Later answer.');
    }
  });
  const oldLock = await mocks.acquireLock();
  const originalTurn = postReply('Original answer.').finally(() => oldLock());
  let drain: Promise<void> | undefined;
  try {
    expect(owner).toBe(oldLock);
    await admitFastAgentHumanFollowUp({ parent, event: first });
    const readRows = () =>
      db.query.fastAgentParentEvents.findMany({
        where: eq(fastAgentParentEvents.conversationId, parent.sessionId),
      });
    expect(await readRows()).toEqual([
      expect.objectContaining({
        event: first,
        admission: null,
        deliveredAt: null,
        discardedAt: null,
        attempts: 0,
      }),
    ]);
    expect(mocks.queueAdd).toHaveBeenCalledWith('deliver', wakeup, {
      jobId: wakeup.eventKey,
    });
    await expect(drainFastAgentParentEvents(wakeup)).rejects.toBeInstanceOf(
      FastAgentParentBusyError,
    );
    expect(mocks.deliverTurn).not.toHaveBeenCalled();
    expect(oldLock).not.toHaveBeenCalled();

    originalCloseout.resolve();
    await originalTurn;
    expect(oldLock).toHaveBeenCalledOnce();
    drain = drainFastAgentParentEvents(wakeup);
    await firstTurnStarted.promise;
    // The first question starts without waiting for the later message to arrive.
    expect(turns).toEqual([first.currentMessageId]);
    await admitFastAgentHumanFollowUp({ parent, event: later });
    await admitFastAgentHumanFollowUp({ parent, event: first });
    expect(await readRows()).toHaveLength(2);
    expect((await readRows()).every((row) => row.deliveredAt === null)).toBe(
      true,
    );
    firstCloseout.resolve();
    await drain;
    await drainFastAgentParentEvents(wakeup);
    expect(turns).toEqual([first.currentMessageId, later.currentMessageId]);
    expect(mocks.deliverTurn).toHaveBeenCalledTimes(2);
    expect(postReply.mock.calls).toEqual([
      ['Original answer.'],
      ['First answer.'],
      ['Later answer.'],
    ]);
    for (const row of await readRows()) {
      expect(row).toMatchObject({ attempts: 1, discardedAt: null });
      expect(row.deliveredAt).toBeInstanceOf(Date);
    }
    expect(owner).toBeUndefined();
  } finally {
    originalCloseout.resolve();
    firstCloseout.resolve();
    await originalTurn;
    await drain;
    await db.delete(users).where(eq(users.id, user.id));
  }
});

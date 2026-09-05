import {
  asc,
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
  userFactory,
} from '@roomote/db/server';
import type {
  FastAgentHumanFollowUpEvent,
  FastAgentParent,
} from '@roomote/types';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  deliver: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  FAST_AGENT_DURABLE_TURN_CLAIM_MS: 15 * 60 * 1000,
  findFastAgentDurableRetryScheduledError: () => null,
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.queueAdd;
  },
}));
vi.mock('@roomote/redis', () => ({ getRedis: () => ({}) }));
vi.mock('./fast-agent-parent-event', () => ({
  buildEventClientMessageSeed: (event: FastAgentHumanFollowUpEvent) =>
    event.eventId,
  deliverFastAgentParentEventWithLock: mocks.deliver,
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

it('keeps busy and release-boundary messages durable, FIFO, and deduplicated', async () => {
  const user = await userFactory.create();
  const [session] = await db
    .insert(fastAgentConversations)
    .values({
      userId: user.id,
      surface: 'web',
      workspaceId: user.id,
      conversationId: `fifo-${user.id}`,
    })
    .returning();
  const parent: FastAgentParent = {
    sessionId: session!.id,
    conversation: {
      surface: 'web',
      workspaceId: user.id,
      conversationId: `fifo-${user.id}`,
    },
  };
  const events: FastAgentHumanFollowUpEvent[] = [
    'first',
    'second',
    'third',
  ].map((id) => ({
    type: 'human_follow_up',
    eventId: id,
    currentMessageId: id,
    userId: user.id,
    question: id,
  }));
  const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
    signal: new AbortController().signal,
  });
  mocks.queueAdd.mockResolvedValue(undefined);
  mocks.deliver.mockResolvedValue('delivered');
  mocks.acquireLock.mockResolvedValue(null);
  try {
    // The first two messages arrive while an existing response owns the lock.
    for (const event of events.slice(0, 2)) {
      expect((await admitFastAgentHumanFollowUp({ parent, event })).kind).toBe(
        'steered',
      );
    }
    const request = {
      conversationId: parent.sessionId,
      eventKey: buildFastAgentParentEventKey({ parent, event: events[0]! }),
    };
    await expect(drainFastAgentParentEvents(request)).rejects.toBeInstanceOf(
      FastAgentParentBusyError,
    );
    expect(mocks.deliver).not.toHaveBeenCalled();

    // A later arrival wins the released lock before the queue worker does.
    mocks.acquireLock.mockResolvedValue(release);
    for (const event of [events[2]!, events[1]!]) {
      expect((await admitFastAgentHumanFollowUp({ parent, event })).kind).toBe(
        'queued',
      );
    }
    const rows = await db.query.fastAgentParentEvents.findMany({
      where: eq(fastAgentParentEvents.conversationId, parent.sessionId),
      orderBy: [
        asc(fastAgentParentEvents.createdAt),
        asc(fastAgentParentEvents.id),
      ],
    });
    expect(rows.map((row) => row.event)).toEqual(events);
    expect(
      rows.every(
        (row) => row.admission === null && !row.deliveredAt && !row.discardedAt,
      ),
    ).toBe(true);

    await drainFastAgentParentEvents(request);
    await drainFastAgentParentEvents(request);
    expect(mocks.deliver.mock.calls.map(([params]) => params.event)).toEqual(
      events,
    );
    expect(release).toHaveBeenCalledTimes(3);
    const settled = await db.query.fastAgentParentEvents.findMany({
      where: eq(fastAgentParentEvents.conversationId, parent.sessionId),
    });
    expect(settled.every((row) => row.deliveredAt && !row.discardedAt)).toBe(
      true,
    );

    // Redelivery after settlement is acknowledged without another turn.
    const duplicate = await admitFastAgentHumanFollowUp({
      parent,
      event: events[0]!,
    });
    expect(duplicate).toMatchObject({ kind: 'turn', durable: null });
    if (duplicate.kind === 'turn') await duplicate.turnLock();
    expect(mocks.deliver).toHaveBeenCalledTimes(3);
  } finally {
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, parent.sessionId));
  }
});

import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
} from '@roomote/db/server';

import { countOverdueQueuedFastAgentParentEvents } from '../fast-agent-parent-event-queue';

/**
 * Runs the real query. The health route only ever saw this through a mock,
 * and a Date bound inside a raw SQL fragment made Postgres reject it, so
 * every tenant's /health/bullmq reported unhealthy for a full release.
 */
describe('countOverdueQueuedFastAgentParentEvents', () => {
  const workspaceId = `ws-${randomUUID()}`;
  let conversationId: string;

  beforeAll(async () => {
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        ownerAutomation: 'health-check-test' as never,
        surface: 'web',
        workspaceId,
        conversationId: `conv-${randomUUID()}`,
      })
      .returning({ id: fastAgentConversations.id });
    conversationId = conversation!.id;
  });

  afterAll(async () => {
    if (!conversationId) return;
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversationId));
  });

  it('counts a queued event owed since before the cutoff and ignores newer or delivered ones', async () => {
    const parent = { sessionId: conversationId } as never;
    const minutesAgo = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000);
    await db.insert(fastAgentParentEvents).values([
      {
        conversationId,
        eventKey: `overdue-${randomUUID()}`,
        parent,
        event: { type: 'test' },
        createdAt: minutesAgo(20),
        updatedAt: minutesAgo(20),
      },
      {
        conversationId,
        eventKey: `fresh-${randomUUID()}`,
        parent,
        event: { type: 'test' },
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      },
      {
        conversationId,
        eventKey: `delivered-${randomUUID()}`,
        parent,
        event: { type: 'test' },
        createdAt: minutesAgo(30),
        updatedAt: minutesAgo(30),
        deliveredAt: minutesAgo(29),
      },
    ]);

    await expect(
      countOverdueQueuedFastAgentParentEvents(minutesAgo(5)),
    ).resolves.toBe(1);
    await expect(
      countOverdueQueuedFastAgentParentEvents(minutesAgo(25)),
    ).resolves.toBe(0);
  });

  describe('events the worker attempted and could not deliver', () => {
    const minutesAgo = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000);
    const minutesFromNow = (minutes: number) =>
      new Date(Date.now() + minutes * 60_000);
    let heldConversationId: string;

    beforeEach(async () => {
      const [conversation] = await db
        .insert(fastAgentConversations)
        .values({
          ownerAutomation: 'health-check-test' as never,
          surface: 'web',
          workspaceId,
          conversationId: `conv-${randomUUID()}`,
        })
        .returning({ id: fastAgentConversations.id });
      heldConversationId = conversation!.id;
    });

    afterEach(async () => {
      await db
        .delete(fastAgentConversations)
        .where(eq(fastAgentConversations.id, heldConversationId));
    });

    const insertEvent = (values: {
      createdAt: Date;
      updatedAt?: Date;
      attempts?: number;
      retryAt?: Date;
      discardedAt?: Date;
      admission?: 'inline';
    }) =>
      db.insert(fastAgentParentEvents).values({
        conversationId: heldConversationId,
        eventKey: `event-${randomUUID()}`,
        parent: { sessionId: heldConversationId } as never,
        event: { type: 'test' },
        updatedAt: values.createdAt,
        ...values,
      });

    it('does not count a parked event or the events held behind it', async () => {
      const before = await countOverdueQueuedFastAgentParentEvents(
        minutesAgo(5),
      );
      // The head failed and is waiting out its backoff.
      await insertEvent({
        createdAt: minutesAgo(60),
        attempts: 4,
        retryAt: minutesFromNow(10),
      });
      // Queued behind it and never attempted: the worker is holding these on
      // purpose to keep the conversation in order, not failing to drain.
      await insertEvent({ createdAt: minutesAgo(50) });
      await insertEvent({ createdAt: minutesAgo(40) });

      await expect(
        countOverdueQueuedFastAgentParentEvents(minutesAgo(5)),
      ).resolves.toBe(before);
    });

    it('does not count a discarded event', async () => {
      const before = await countOverdueQueuedFastAgentParentEvents(
        minutesAgo(5),
      );
      await insertEvent({
        createdAt: minutesAgo(60),
        attempts: 1,
        discardedAt: minutesAgo(59),
      });

      await expect(
        countOverdueQueuedFastAgentParentEvents(minutesAgo(5)),
      ).resolves.toBe(before);
    });

    it('counts the head and what it held once its retry is overdue', async () => {
      const before = await countOverdueQueuedFastAgentParentEvents(
        minutesAgo(5),
      );
      // The retry came due twenty minutes ago and nothing picked it up: the
      // worker really is not draining.
      await insertEvent({
        createdAt: minutesAgo(60),
        attempts: 4,
        retryAt: minutesAgo(20),
      });
      await insertEvent({ createdAt: minutesAgo(50) });

      await expect(
        countOverdueQueuedFastAgentParentEvents(minutesAgo(5)),
      ).resolves.toBe(before + 2);
    });

    it('still counts events behind a parked inline turn, which holds nothing', async () => {
      const before = await countOverdueQueuedFastAgentParentEvents(
        minutesAgo(5),
      );
      await insertEvent({
        createdAt: minutesAgo(60),
        admission: 'inline',
        retryAt: minutesFromNow(10),
      });
      await insertEvent({ createdAt: minutesAgo(50) });

      await expect(
        countOverdueQueuedFastAgentParentEvents(minutesAgo(5)),
      ).resolves.toBe(before + 1);
    });
  });
});

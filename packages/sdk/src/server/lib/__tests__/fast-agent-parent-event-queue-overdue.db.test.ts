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
});

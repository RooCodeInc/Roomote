// Real-DB coverage for the Fast conversation-memory outbox. The
// unique(conversationId) contract is load-bearing: every save_memory call in
// a conversation converges on one accumulating row, which the ingestion
// drainer re-puts idempotently at one conversation-specific slug.

import { FAST_AGENT_MEMORY_MAX_CHARS } from '@roomote/types';

import {
  db,
  eq,
  sql,
  userFactory,
  fastAgentConversations,
  fastAgentMemoryEvents,
  appendFastAgentMemory,
  claimPendingFastAgentMemoryEvents,
  markFastAgentMemoryEvent,
  releaseFastAgentMemoryEvents,
  settleFastAgentMemoryEvent,
} from '../../server';
import { runMemoryOutboxLifecycleContract } from './memory-outbox-lifecycle.contract';

const createdUserIds: string[] = [];

async function makeConversation() {
  const user = await userFactory.create();
  createdUserIds.push(user.id);

  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: user.id,
      surface: 'web',
      workspaceId: user.id,
      conversationId: `conversation-${crypto.randomUUID()}`,
    })
    .returning();

  return conversation!;
}

afterEach(async () => {
  await db.delete(fastAgentMemoryEvents);

  for (const userId of createdUserIds.splice(0)) {
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.userId, userId));
  }
});

describe('appendFastAgentMemory', () => {
  it('creates the conversation row on first save and accumulates later facts', async () => {
    const conversation = await makeConversation();

    expect(
      await appendFastAgentMemory(db, conversation.id, 'prefers tabular diffs'),
    ).toEqual({ saved: true });
    expect(
      await appendFastAgentMemory(db, conversation.id, 'deploys on Fridays'),
    ).toEqual({ saved: true });

    const [row] = await db
      .select()
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.conversationId, conversation.id));

    expect(row!.memory).toBe('- prefers tabular diffs\n- deploys on Fridays');
    expect(row!.status).toBe('pending');
  });

  it('resets an ingested row to pending so richer content re-ingests', async () => {
    const conversation = await makeConversation();
    await appendFastAgentMemory(db, conversation.id, 'first fact');

    const [claimed] = await claimPendingFastAgentMemoryEvents(db, 10);
    await settleFastAgentMemoryEvent(
      db,
      claimed!.id,
      claimed!.revision,
      'done',
    );

    await appendFastAgentMemory(db, conversation.id, 'second fact');

    const [row] = await db
      .select()
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.conversationId, conversation.id));

    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);
    expect(row!.lastError).toBeNull();
    expect(row!.memory).toContain('second fact');
  });

  it('refuses a save that would exceed the memory cap', async () => {
    const conversation = await makeConversation();
    await db.insert(fastAgentMemoryEvents).values({
      conversationId: conversation.id,
      memory: 'x'.repeat(FAST_AGENT_MEMORY_MAX_CHARS - 10),
    });

    expect(
      await appendFastAgentMemory(db, conversation.id, 'one fact too many'),
    ).toEqual({ saved: false, reason: 'memory_full' });
  });
});

describe('claim/release/mark', () => {
  it('claims pending events once and charges an attempt', async () => {
    const conversation = await makeConversation();
    await appendFastAgentMemory(db, conversation.id, 'a fact');

    const claimed = await claimPendingFastAgentMemoryEvents(db, 10);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe('processing');
    expect(claimed[0]!.attempts).toBe(1);

    // A fresh (non-stale) processing row is not reclaimed.
    expect(await claimPendingFastAgentMemoryEvents(db, 10)).toHaveLength(0);
  });

  it('release refunds the attempt and returns the event to pending', async () => {
    const conversation = await makeConversation();
    await appendFastAgentMemory(db, conversation.id, 'a fact');
    const [claimed] = await claimPendingFastAgentMemoryEvents(db, 10);

    await releaseFastAgentMemoryEvents(db, [claimed!.id]);

    const [row] = await db
      .select()
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.id, claimed!.id));

    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);
  });

  it('keeps a claimed row with a single writer and fences its completion', async () => {
    const conversation = await makeConversation();
    await appendFastAgentMemory(db, conversation.id, 'first fact');
    const [claimed] = await claimPendingFastAgentMemoryEvents(db, 10);

    // A save lands between the claim and the drainer's completion. The row
    // stays 'processing' (no second writer can claim it), but its revision
    // moves past the drainer's snapshot.
    await appendFastAgentMemory(db, conversation.id, 'late fact');

    expect(await claimPendingFastAgentMemoryEvents(db, 10)).toHaveLength(0);

    expect(
      await settleFastAgentMemoryEvent(
        db,
        claimed!.id,
        claimed!.revision,
        'done',
      ),
    ).toBe('superseded');

    const [row] = await db
      .select()
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.id, claimed!.id));

    expect(row!.status).toBe('pending');
    expect(row!.processedAt).toBeNull();
    expect(row!.memory).toContain('late fact');

    // The next tick re-claims it and completes normally.
    const [reclaimed] = await claimPendingFastAgentMemoryEvents(db, 10);

    expect(
      await settleFastAgentMemoryEvent(
        db,
        reclaimed!.id,
        reclaimed!.revision,
        'done',
      ),
    ).toBe('settled');

    const [settled] = await db
      .select()
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.id, claimed!.id));

    expect(settled!.status).toBe('done');
  });

  it('re-queues a settled row when a stale-reclaimed writer returns late', async () => {
    const conversation = await makeConversation();
    await appendFastAgentMemory(db, conversation.id, 'first fact');

    // Writer A claims, then hangs in its page write past the reclaim window.
    const [claimedA] = await claimPendingFastAgentMemoryEvents(db, 10);
    await appendFastAgentMemory(db, conversation.id, 'late fact');
    await db
      .update(fastAgentMemoryEvents)
      .set({ updatedAt: sql`now() - interval '16 minutes'` })
      .where(eq(fastAgentMemoryEvents.id, claimedA!.id));

    // Writer B stale-reclaims the newer revision, writes it, settles done.
    const [claimedB] = await claimPendingFastAgentMemoryEvents(db, 10);
    expect(claimedB!.revision).toBeGreaterThan(claimedA!.revision);
    expect(
      await settleFastAgentMemoryEvent(
        db,
        claimedB!.id,
        claimedB!.revision,
        'done',
      ),
    ).toBe('settled');

    // A's stale page write finally lands and A settles: the fence miss must
    // re-queue the row even though it is already 'done', so the next tick
    // re-puts the newest content over A's stale snapshot.
    expect(
      await settleFastAgentMemoryEvent(
        db,
        claimedA!.id,
        claimedA!.revision,
        'done',
      ),
    ).toBe('superseded');

    const [row] = await db
      .select()
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.id, claimedA!.id));

    expect(row!.status).toBe('pending');
    expect(row!.processedAt).toBeNull();

    const [reclaimed] = await claimPendingFastAgentMemoryEvents(db, 10);
    expect(
      await settleFastAgentMemoryEvent(
        db,
        reclaimed!.id,
        reclaimed!.revision,
        'done',
      ),
    ).toBe('settled');
  });

  it('settling done stamps processedAt', async () => {
    const conversation = await makeConversation();
    await appendFastAgentMemory(db, conversation.id, 'a fact');
    const [claimed] = await claimPendingFastAgentMemoryEvents(db, 10);

    expect(
      await settleFastAgentMemoryEvent(
        db,
        claimed!.id,
        claimed!.revision,
        'done',
      ),
    ).toBe('settled');

    const [row] = await db
      .select()
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.id, claimed!.id));

    expect(row!.status).toBe('done');
    expect(row!.processedAt).not.toBeNull();
  });

  it('marking skipped applies only to a still-claimed row', async () => {
    const conversation = await makeConversation();
    await appendFastAgentMemory(db, conversation.id, 'a fact');
    const [claimed] = await claimPendingFastAgentMemoryEvents(db, 10);

    await markFastAgentMemoryEvent(db, claimed!.id, 'skipped', 'gone');

    const [row] = await db
      .select()
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.id, claimed!.id));

    expect(row!.status).toBe('skipped');
  });

  it('deleting the conversation cascades to its memory row', async () => {
    const conversation = await makeConversation();
    await appendFastAgentMemory(db, conversation.id, 'a fact');

    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversation.id));

    expect(
      await db
        .select()
        .from(fastAgentMemoryEvents)
        .where(eq(fastAgentMemoryEvents.conversationId, conversation.id)),
    ).toHaveLength(0);
  });
});

runMemoryOutboxLifecycleContract('Fast memory', () => {
  let conversationId: string | null = null;

  return {
    async createEvent() {
      const conversation = await makeConversation();
      conversationId = conversation.id;
      await appendFastAgentMemory(db, conversation.id, 'first fact');
      const [event] = await db
        .select()
        .from(fastAgentMemoryEvents)
        .where(eq(fastAgentMemoryEvents.conversationId, conversation.id));
      return event!;
    },
    claim: () => claimPendingFastAgentMemoryEvents(db, 10),
    release: (ids) => releaseFastAgentMemoryEvents(db, ids),
    mark: (id, status, error) =>
      markFastAgentMemoryEvent(db, id, status, error),
    settle: (id, revision, outcome, error) =>
      settleFastAgentMemoryEvent(db, id, revision, outcome, error),
    async revise() {
      await appendFastAgentMemory(db, conversationId!, 'newer fact');
    },
    async age(id) {
      await db
        .update(fastAgentMemoryEvents)
        .set({ updatedAt: sql`now() - interval '16 minutes'` })
        .where(eq(fastAgentMemoryEvents.id, id));
    },
    async read(id) {
      const [row] = await db
        .select()
        .from(fastAgentMemoryEvents)
        .where(eq(fastAgentMemoryEvents.id, id));
      return row!;
    },
  };
});

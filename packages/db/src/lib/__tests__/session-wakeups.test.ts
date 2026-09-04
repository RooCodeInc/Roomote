// Real-DB coverage for session wakeups. The compare-and-set claim on
// next_run_at is load-bearing: it is what keeps a duplicate delayed job, or
// two workers holding the same job, from firing one occurrence twice.

import { SESSION_WAKEUP_MAX_CONSECUTIVE_FAILURES } from '@roomote/types';

import {
  cancelSessionWakeup,
  cancelSessionWakeupsForConversation,
  claimSessionWakeupFire,
  countActiveSessionWakeups,
  db,
  fastAgentConversations,
  getSessionWakeupById,
  insertSessionWakeup,
  listDueSessionWakeups,
  listSessionWakeups,
  recordSessionWakeupOutcome,
  sessionWakeups,
  userFactory,
} from '../../server';

async function makeConversation() {
  const user = await userFactory.create();
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: user.id,
      surface: 'web',
      workspaceId: user.id,
      conversationId: `conversation-${crypto.randomUUID()}`,
    })
    .returning();
  return { user, conversation: conversation! };
}

const firstRunAt = new Date('2026-09-04T17:10:00.000Z');

async function makeWakeup(
  conversationId: string,
  userId: string,
  overrides: Partial<Parameters<typeof insertSessionWakeup>[0]> = {},
) {
  return insertSessionWakeup({
    conversationId,
    createdByUserId: userId,
    name: 'Check PR #85',
    prompt: 'Check whether PR #85 merged.',
    schedule: { mode: 'interval', everyMinutes: 10 },
    reportPolicy: 'only_when_notable',
    maxRuns: null,
    until: null,
    nextRunAt: firstRunAt,
    ...overrides,
  });
}

afterEach(async () => {
  await db.delete(sessionWakeups);
});

describe('session wakeup helpers', () => {
  it('claims an occurrence exactly once and advances the row', async () => {
    const { user, conversation } = await makeConversation();
    const row = await makeWakeup(conversation.id, user.id);
    const nextRunAt = new Date('2026-09-04T17:20:00.000Z');
    const firedAt = new Date('2026-09-04T17:10:02.000Z');

    const claimed = await claimSessionWakeupFire({
      id: row.id,
      expectedNextRunAt: firstRunAt,
      nextRunAt,
      firedAt,
    });
    expect(claimed?.runCount).toBe(1);
    expect(claimed?.status).toBe('active');
    expect(claimed?.nextRunAt?.toISOString()).toBe(nextRunAt.toISOString());

    // A duplicate job for the same occurrence finds the row already moved.
    const duplicate = await claimSessionWakeupFire({
      id: row.id,
      expectedNextRunAt: firstRunAt,
      nextRunAt: new Date('2026-09-04T17:30:00.000Z'),
      firedAt,
    });
    expect(duplicate).toBeNull();
    expect((await getSessionWakeupById(row.id))?.runCount).toBe(1);
  });

  it('completes the row when the claim carries no next occurrence', async () => {
    const { user, conversation } = await makeConversation();
    const row = await makeWakeup(conversation.id, user.id, {
      schedule: { mode: 'once', at: firstRunAt.toISOString() },
      reportPolicy: 'always',
    });

    const claimed = await claimSessionWakeupFire({
      id: row.id,
      expectedNextRunAt: firstRunAt,
      nextRunAt: null,
      firedAt: firstRunAt,
    });
    expect(claimed?.status).toBe('completed');
    expect(claimed?.nextRunAt).toBeNull();
    expect(claimed?.completedAt).not.toBeNull();
    expect(await countActiveSessionWakeups(conversation.id)).toBe(0);
  });

  it('retires an active wakeup after enough consecutive failures', async () => {
    const { user, conversation } = await makeConversation();
    const row = await makeWakeup(conversation.id, user.id);

    for (let i = 1; i < SESSION_WAKEUP_MAX_CONSECUTIVE_FAILURES; i += 1) {
      const updated = await recordSessionWakeupOutcome({
        id: row.id,
        status: 'failed',
        error: `boom ${i}`,
      });
      expect(updated?.status).toBe('active');
      expect(updated?.consecutiveFailures).toBe(i);
    }
    const succeeded = await recordSessionWakeupOutcome({
      id: row.id,
      status: 'succeeded',
    });
    expect(succeeded?.consecutiveFailures).toBe(0);
    expect(succeeded?.lastError).toBeNull();

    let last = null;
    for (let i = 0; i < SESSION_WAKEUP_MAX_CONSECUTIVE_FAILURES; i += 1) {
      last = await recordSessionWakeupOutcome({
        id: row.id,
        status: 'failed',
        error: 'still broken',
      });
    }
    expect(last?.status).toBe('failed');
    expect(last?.nextRunAt).toBeNull();
    expect(last?.lastError).toBe('still broken');
  });

  it('cancels only active rows scoped to their conversation', async () => {
    const { user, conversation } = await makeConversation();
    const other = await makeConversation();
    const row = await makeWakeup(conversation.id, user.id);

    expect(
      await cancelSessionWakeup({
        id: row.id,
        conversationId: other.conversation.id,
      }),
    ).toBeNull();
    const cancelled = await cancelSessionWakeup({
      id: row.id,
      conversationId: conversation.id,
    });
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.nextRunAt).toBeNull();
    expect(
      await cancelSessionWakeup({
        id: row.id,
        conversationId: conversation.id,
      }),
    ).toBeNull();
  });

  it('cancels every active wakeup in a conversation and keeps history', async () => {
    const { user, conversation } = await makeConversation();
    await makeWakeup(conversation.id, user.id, { name: 'A' });
    await makeWakeup(conversation.id, user.id, {
      name: 'B',
      prompt: 'Something else entirely.',
    });

    expect(await cancelSessionWakeupsForConversation(conversation.id)).toBe(2);
    expect(await countActiveSessionWakeups(conversation.id)).toBe(0);
    expect(await listSessionWakeups(conversation.id)).toHaveLength(0);
    expect(
      await listSessionWakeups(conversation.id, { includeTerminal: true }),
    ).toHaveLength(2);
  });

  it('lists due rows for recovery', async () => {
    const { user, conversation } = await makeConversation();
    const due = await makeWakeup(conversation.id, user.id, { name: 'Due' });
    await makeWakeup(conversation.id, user.id, {
      name: 'Later',
      prompt: 'Later prompt for a different check.',
      nextRunAt: new Date('2026-09-04T18:00:00.000Z'),
    });

    const rows = await listDueSessionWakeups({
      dueBy: new Date('2026-09-04T17:12:00.000Z'),
    });
    expect(rows.map((row) => row.id)).toEqual([due.id]);
  });
});

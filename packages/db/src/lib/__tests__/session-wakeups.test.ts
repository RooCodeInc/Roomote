// Real-DB coverage for session wakeups. The compare-and-set claim on
// next_run_at is load-bearing: it is what keeps a duplicate delayed job, or
// two workers holding the same job, from firing one occurrence twice.

import {
  MAX_ACTIVE_SESSION_WAKEUPS,
  SESSION_WAKEUP_MAX_CONSECUTIVE_FAILURES,
} from '@roomote/types';

import {
  admitSessionWakeup,
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
  it('deduplicates relative retries with changed resolved times, not distinct delays or prompts', async () => {
    const { user, conversation } = await makeConversation();
    const input = {
      conversationId: conversation.id,
      createdByUserId: user.id,
      name: 'Reminder',
      prompt: 'Check the deploy.',
      schedule: {
        mode: 'once' as const,
        at: firstRunAt.toISOString(),
        inMinutes: 2,
      },
      reportPolicy: 'always' as const,
      maxRuns: null,
      until: null,
      nextRunAt: firstRunAt,
    };
    const first = await admitSessionWakeup(input);
    expect(first.outcome).toBe('created');
    const later = new Date(firstRunAt.getTime() + 5_000);
    const retry = {
      ...input,
      prompt: ' CHECK  THE DEPLOY. ',
      schedule: { ...input.schedule, at: later.toISOString() },
      nextRunAt: later,
    };
    expect(await admitSessionWakeup(retry)).toEqual({
      ...first,
      outcome: 'duplicate',
    });
    const [persisted] = await listSessionWakeups(conversation.id);
    expect(persisted!.schedule).toEqual(input.schedule);
    expect(persisted!.nextRunAt).toEqual(firstRunAt);
    expect(
      await admitSessionWakeup({
        ...retry,
        schedule: { ...retry.schedule, inMinutes: 3 },
      }),
    ).toMatchObject({ outcome: 'created' });
    expect(
      await admitSessionWakeup({ ...retry, prompt: 'Check another deploy.' }),
    ).toMatchObject({ outcome: 'created' });
    expect(await listSessionWakeups(conversation.id)).toHaveLength(3);
  });

  it('does not infer relative identity from legacy or absolute one-shots', async () => {
    const { user, conversation } = await makeConversation();
    const legacy = await makeWakeup(conversation.id, user.id, {
      schedule: { mode: 'once', at: firstRunAt.toISOString() },
    });
    const input = { ...legacy, nextRunAt: firstRunAt };
    expect(await admitSessionWakeup(input)).toMatchObject({
      outcome: 'duplicate',
      wakeup: { id: legacy.id },
    });
    expect(
      await admitSessionWakeup({
        ...input,
        schedule: { mode: 'once', at: firstRunAt.toISOString(), inMinutes: 2 },
      }),
    ).toMatchObject({ outcome: 'created' });
    const later = new Date(firstRunAt.getTime() + 5_000);
    expect(
      await admitSessionWakeup({
        ...input,
        schedule: { mode: 'once', at: later.toISOString() },
        nextRunAt: later,
      }),
    ).toMatchObject({ outcome: 'created' });
  });

  it.each([
    { mode: 'once' as const, at: firstRunAt.toISOString() },
    { mode: 'cron' as const, expression: '*/10 * * * *', timezone: 'UTC' },
  ])(
    'deduplicates $mode schedules after JSONB reorders keys',
    async (schedule) => {
      const { user, conversation } = await makeConversation();
      const input = {
        conversationId: conversation.id,
        createdByUserId: user.id,
        name: 'Check PR',
        prompt: 'check pr',
        schedule,
        reportPolicy: 'only_when_notable' as const,
        maxRuns: null,
        until: null,
        nextRunAt: firstRunAt,
      };
      expect(await admitSessionWakeup(input)).toMatchObject({
        outcome: 'created',
      });
      const [persisted] = await listSessionWakeups(conversation.id);
      expect(persisted!.schedule).toEqual(schedule);
      expect(Object.keys(persisted!.schedule)).not.toEqual(
        Object.keys(schedule),
      );

      expect(await admitSessionWakeup(input)).toMatchObject({
        outcome: 'duplicate',
        wakeup: { id: persisted!.id },
      });
      expect(await listSessionWakeups(conversation.id)).toHaveLength(1);
    },
  );

  it('deduplicates concurrent recurring creates in one conversation', async () => {
    const { user, conversation } = await makeConversation();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        admitSessionWakeup({
          conversationId: conversation.id,
          createdByUserId: user.id,
          name: `Check ${index}`,
          prompt: index % 2 ? ' CHECK  PR ' : 'check pr',
          schedule: { mode: 'interval', everyMinutes: 10 },
          reportPolicy: 'only_when_notable',
          maxRuns: null,
          until: null,
          nextRunAt: new Date(firstRunAt.getTime() + index),
        }),
      ),
    );

    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(11);
    const rows = await listSessionWakeups(conversation.id);
    expect(rows).toHaveLength(1);
    for (const result of results) {
      expect(result).toMatchObject({ wakeup: { id: rows[0]!.id } });
    }
  });

  it('caps concurrent distinct creates at ten and still admits duplicates', async () => {
    const { user, conversation } = await makeConversation();
    const input = {
      conversationId: conversation.id,
      createdByUserId: user.id,
      name: 'Check PR',
      prompt: 'check pr',
      schedule: { mode: 'interval' as const, everyMinutes: 10 },
      reportPolicy: 'only_when_notable' as const,
      maxRuns: null,
      until: null,
      nextRunAt: firstRunAt,
    };
    const results = await Promise.all(
      Array.from({ length: MAX_ACTIVE_SESSION_WAKEUPS + 5 }, (_, index) =>
        admitSessionWakeup({ ...input, prompt: `check pr ${index}` }),
      ),
    );

    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(
      MAX_ACTIVE_SESSION_WAKEUPS,
    );
    expect(results.filter((r) => r.outcome === 'cap_reached')).toHaveLength(5);
    expect(await countActiveSessionWakeups(conversation.id)).toBe(
      MAX_ACTIVE_SESSION_WAKEUPS,
    );
    const rows = await listSessionWakeups(conversation.id);
    expect(
      await admitSessionWakeup({ ...input, prompt: rows[0]!.prompt }),
    ).toMatchObject({ outcome: 'duplicate', wakeup: { id: rows[0]!.id } });
  });

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

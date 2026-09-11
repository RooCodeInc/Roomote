import {
  db,
  eq,
  fastAgentConversations,
  listSessionWakeups,
  sessionWakeups,
  userFactory,
  users,
} from '@roomote/db/server';

import { enqueueSessionWakeupFireBestEffort } from './queue';
import {
  ensureOwnTaskFollowThroughWakeup,
  handleManageWakeupsToolCall,
  type SessionWakeupActor,
} from './service';

vi.mock('./queue', () => ({
  enqueueSessionWakeupFireBestEffort: vi.fn(),
}));

const now = new Date('2026-09-05T12:00:00.000Z');
const createInput = {
  action: 'create' as const,
  name: 'Reminder',
  prompt: 'Check the deploy.',
  schedule: 'in 30s',
};
const ownTaskFollowThroughInput = {
  action: 'create' as const,
  name: 'Follow through on session tasks',
  prompt:
    'Run the Own Coding Task Follow-Through session check for all tasks in this conversation. Follow that system policy exactly, including inspection, reporting, correction, stopping, and rearming.',
  schedule: 'in 10m',
  reportPolicy: 'only_when_notable' as const,
};

describe('handleManageWakeupsToolCall relative reminders', () => {
  let actor: SessionWakeupActor;

  beforeEach(async () => {
    vi.clearAllMocks();
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
    actor = { conversationId: conversation!.id, userId: user.id };
    // Freeze new Date() without replacing timers used by the database client.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db
      .delete(sessionWakeups)
      .where(eq(sessionWakeups.conversationId, actor.conversationId));
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, actor.conversationId));
    await db.delete(users).where(eq(users.id, actor.userId));
    vi.clearAllMocks();
  });

  it.each(['in 30s', 'in 30 seconds'])(
    'persists %s and reuses its original run time on a later retry',
    async (schedule) => {
      const input = { ...createInput, schedule };
      const nextRunAt = new Date(now.getTime() + 30_000);
      const result = await handleManageWakeupsToolCall(actor, input);

      expect(result).toMatchObject({
        success: true,
        duplicate: false,
        wakeup: {
          schedule: {
            mode: 'once',
            at: nextRunAt.toISOString(),
            inMinutes: 0.5,
          },
          nextRunAt: nextRunAt.toISOString(),
          reportPolicy: 'always',
          internal: false,
          status: 'active',
        },
        note: 'Scheduled. When it fires you will receive a scheduled_wakeup platform event in this conversation.',
      });
      const rows = await listSessionWakeups(actor.conversationId);
      expect(rows).toHaveLength(1);
      const stored = rows[0]!;
      expect(stored).toMatchObject({
        schedule: { mode: 'once', at: nextRunAt.toISOString(), inMinutes: 0.5 },
        nextRunAt,
        reportPolicy: 'always',
        internal: false,
        status: 'active',
      });
      expect(
        enqueueSessionWakeupFireBestEffort,
      ).toHaveBeenCalledExactlyOnceWith({
        wakeupId: stored.id,
        runAt: nextRunAt.getTime(),
      });

      vi.setSystemTime(new Date(now.getTime() + 5_000));
      const retry = await handleManageWakeupsToolCall(actor, input);
      expect(retry).toMatchObject({
        success: true,
        duplicate: true,
        wakeup: result.wakeup,
      });
      expect(await listSessionWakeups(actor.conversationId)).toEqual(rows);
      expect(enqueueSessionWakeupFireBestEffort).toHaveBeenCalledTimes(1);
    },
  );

  it('deduplicates equivalent seconds and minutes schedules', async () => {
    const nextRunAt = new Date(now.getTime() + 60_000);
    const first = await handleManageWakeupsToolCall(actor, {
      ...createInput,
      schedule: 'in 60s',
    });
    expect(first).toMatchObject({
      success: true,
      duplicate: false,
      wakeup: {
        schedule: { mode: 'once', inMinutes: 1 },
        nextRunAt: nextRunAt.toISOString(),
      },
    });

    vi.setSystemTime(new Date(now.getTime() + 5_000));
    expect(
      await handleManageWakeupsToolCall(actor, {
        ...createInput,
        schedule: 'in 1m',
      }),
    ).toMatchObject({ success: true, duplicate: true, wakeup: first.wakeup });
    const rows = await listSessionWakeups(actor.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      schedule: { mode: 'once', at: nextRunAt.toISOString(), inMinutes: 1 },
      nextRunAt,
    });
    expect(enqueueSessionWakeupFireBestEffort).toHaveBeenCalledExactlyOnceWith({
      wakeupId: rows[0]!.id,
      runAt: nextRunAt.getTime(),
    });
  });

  it('rejects fractional textual minutes without persisting or queueing', async () => {
    expect(
      await handleManageWakeupsToolCall(actor, {
        ...createInput,
        schedule: 'in 0.5m',
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('Could not read the schedule "in 0.5m"'),
    });
    expect(await listSessionWakeups(actor.conversationId)).toEqual([]);
    expect(enqueueSessionWakeupFireBestEffort).not.toHaveBeenCalled();
  });

  it('accepts explicit internal wakeups and keeps user reminders visible by default', async () => {
    const internal = await handleManageWakeupsToolCall(actor, {
      ...createInput,
      internal: true,
    });
    expect(internal).toMatchObject({
      success: true,
      duplicate: false,
      wakeup: { internal: true, status: 'active' },
    });

    const visible = await handleManageWakeupsToolCall(actor, createInput);
    expect(visible).toMatchObject({
      success: true,
      duplicate: false,
      wakeup: { internal: false, status: 'active' },
    });
    await expect(
      handleManageWakeupsToolCall(actor, createInput),
    ).resolves.toMatchObject({
      success: true,
      duplicate: true,
      wakeup: { id: (visible.wakeup as { id: string }).id, internal: false },
    });
  });

  it('creates and rearms task follow-through as explicitly internal', async () => {
    const created = await ensureOwnTaskFollowThroughWakeup(actor);
    const sourceWakeupId = created.wakeup.id;
    await db
      .update(sessionWakeups)
      .set({ status: 'completed', nextRunAt: null })
      .where(eq(sessionWakeups.id, sourceWakeupId));

    vi.setSystemTime(new Date(now.getTime() + 10 * 60_000));
    const rearmed = await handleManageWakeupsToolCall(actor, {
      ...ownTaskFollowThroughInput,
      internal: true,
    });
    expect(rearmed).toMatchObject({
      success: true,
      duplicate: false,
      wakeup: {
        name: 'Follow through on session tasks',
        internal: true,
        status: 'active',
      },
    });
    expect((rearmed.wakeup as { id: string }).id).not.toBe(sourceWakeupId);

    expect(enqueueSessionWakeupFireBestEffort).toHaveBeenNthCalledWith(2, {
      wakeupId: expect.any(String),
      runAt: now.getTime() + 20 * 60_000,
    });

    const rows = await listSessionWakeups(actor.conversationId, {
      includeTerminal: true,
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sourceWakeupId, internal: true }),
        expect.objectContaining({
          id: (rearmed.wakeup as { id: string }).id,
          internal: true,
        }),
      ]),
    );
  });
});

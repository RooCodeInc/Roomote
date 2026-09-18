const mocks = vi.hoisted(() => ({
  enqueueFire: vi.fn(),
  findById: vi.fn(),
  resolveNextRun: vi.fn(),
  claimFire: vi.fn(),
  getById: vi.fn(),
  listDue: vi.fn(),
  recordOutcome: vi.fn(),
  enqueueParentEvent: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  SESSION_WAKEUP_FIRE_JOB_NAME: 'fire',
  SESSION_WAKEUP_QUEUE_NAME: 'session-wakeups',
  enqueueSessionWakeupFire: mocks.enqueueFire,
  fastAgentConversationRepository: { findById: mocks.findById },
  resolveSessionWakeupNextRun: mocks.resolveNextRun,
}));

vi.mock('@roomote/db/server', () => ({
  claimSessionWakeupFire: mocks.claimFire,
  getSessionWakeupById: mocks.getById,
  listDueSessionWakeups: mocks.listDue,
  recordSessionWakeupOutcome: mocks.recordOutcome,
}));

vi.mock('./fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueParentEvent,
}));

import {
  fireSessionWakeup,
  recoverPendingSessionWakeups,
} from './session-wakeups';

const conversation = {
  surface: 'web' as const,
  workspaceId: 'deployment',
  conversationId: 'conversation-1',
};

const nextRunAt = new Date('2026-09-04T17:10:00.000Z');

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wakeup-1',
    conversationId: '11111111-1111-4111-8111-111111111111',
    createdByUserId: 'user-1',
    name: 'Check PR #85',
    prompt: 'Check whether PR #85 merged.',
    promptSignature: 'check whether pr #85 merged.',
    schedule: { mode: 'interval', everyMinutes: 10 },
    reportPolicy: 'only_when_notable',
    status: 'active',
    runCount: 2,
    maxRuns: null,
    until: null,
    consecutiveFailures: 0,
    nextRunAt,
    lastFiredAt: null,
    lastError: null,
    completedAt: null,
    createdAt: new Date('2026-09-04T16:00:00.000Z'),
    updatedAt: new Date('2026-09-04T16:00:00.000Z'),
    ...overrides,
  };
}

describe('fireSessionWakeup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.findById.mockResolvedValue({ userId: 'owner-1', conversation });
    mocks.enqueueParentEvent.mockResolvedValue({ eventKey: 'k', queued: true });
    mocks.enqueueFire.mockResolvedValue(undefined);
    mocks.recordOutcome.mockResolvedValue(null);
  });

  it('admits the event before claiming, then schedules the next occurrence', async () => {
    const row = activeRow();
    const following = new Date('2026-09-04T17:20:00.000Z');
    mocks.getById.mockResolvedValue(row);
    mocks.resolveNextRun.mockReturnValue(following);
    mocks.claimFire.mockResolvedValue({ ...row, runCount: 3 });

    const result = await fireSessionWakeup({
      wakeupId: row.id,
      runAt: nextRunAt.getTime(),
    });

    expect(result).toEqual({
      outcome: 'fired',
      eventId: 'wakeup-1:3',
      nextRunAt: following,
    });
    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({
      parent: { sessionId: row.conversationId, conversation },
      event: expect.objectContaining({
        type: 'scheduled_wakeup',
        eventId: 'wakeup-1:3',
        wakeupId: 'wakeup-1',
        runNumber: 3,
        prompt: row.prompt,
        reportPolicy: 'only_when_notable',
        createdByUserId: 'user-1',
        nextRunAt: following.toISOString(),
      }),
    });
    expect(mocks.enqueueParentEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimFire.mock.invocationCallOrder[0]!,
    );
    expect(mocks.claimFire).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wakeup-1',
        expectedNextRunAt: nextRunAt,
        nextRunAt: following,
      }),
    );
    expect(mocks.enqueueFire).toHaveBeenCalledWith({
      wakeupId: 'wakeup-1',
      runAt: following.getTime(),
    });
  });

  it('skips a stale job whose occurrence already advanced', async () => {
    mocks.getById.mockResolvedValue(activeRow());

    const result = await fireSessionWakeup({
      wakeupId: 'wakeup-1',
      runAt: nextRunAt.getTime() - 60_000,
    });

    expect(result.outcome).toBe('skipped');
    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
    expect(mocks.claimFire).not.toHaveBeenCalled();
  });

  it('skips terminal wakeups without touching the conversation', async () => {
    mocks.getById.mockResolvedValue(
      activeRow({ status: 'cancelled', nextRunAt: null }),
    );

    const result = await fireSessionWakeup({
      wakeupId: 'wakeup-1',
      runAt: nextRunAt.getTime(),
    });

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'Wakeup is cancelled.',
    });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('does not schedule a follow-up when another worker won the claim', async () => {
    mocks.getById.mockResolvedValue(activeRow());
    mocks.resolveNextRun.mockReturnValue(new Date('2026-09-04T17:20:00.000Z'));
    mocks.claimFire.mockResolvedValue(null);

    const result = await fireSessionWakeup({
      wakeupId: 'wakeup-1',
      runAt: nextRunAt.getTime(),
    });

    expect(result.outcome).toBe('skipped');
    expect(mocks.enqueueParentEvent).toHaveBeenCalledOnce();
    expect(mocks.enqueueFire).not.toHaveBeenCalled();
  });

  it('completes a once wakeup after its only run', async () => {
    const row = activeRow({
      schedule: { mode: 'once', at: nextRunAt.toISOString() },
      reportPolicy: 'always',
      runCount: 0,
    });
    mocks.getById.mockResolvedValue(row);
    mocks.resolveNextRun.mockReturnValue(null);
    mocks.claimFire.mockResolvedValue({ ...row, status: 'completed' });

    const result = await fireSessionWakeup({
      wakeupId: row.id,
      runAt: nextRunAt.getTime(),
    });

    expect(result).toEqual({
      outcome: 'fired',
      eventId: 'wakeup-1:1',
      nextRunAt: null,
    });
    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ nextRunAt: null, maxRuns: null }),
      }),
    );
    expect(mocks.enqueueFire).not.toHaveBeenCalled();
  });

  it('records a failure and advances when the conversation is gone', async () => {
    const row = activeRow();
    mocks.getById.mockResolvedValue(row);
    mocks.findById.mockResolvedValue(null);
    mocks.resolveNextRun.mockReturnValue(new Date('2026-09-04T17:20:00.000Z'));
    mocks.claimFire.mockResolvedValue(row);

    const result = await fireSessionWakeup({
      wakeupId: row.id,
      runAt: nextRunAt.getTime(),
    });

    expect(result.outcome).toBe('skipped');
    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
    expect(mocks.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wakeup-1', status: 'failed' }),
    );
    expect(mocks.enqueueFire).toHaveBeenCalledOnce();
  });
});

describe('recoverPendingSessionWakeups', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('re-adds a hint for every due row and survives one failure', async () => {
    mocks.listDue.mockResolvedValue([
      { id: 'a', nextRunAt: new Date('2026-09-04T17:00:00.000Z') },
      { id: 'b', nextRunAt: new Date('2026-09-04T17:01:00.000Z') },
      { id: 'c', nextRunAt: null },
    ]);
    mocks.enqueueFire
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis restarting'));

    await expect(
      recoverPendingSessionWakeups(new Date('2026-09-04T17:00:30.000Z')),
    ).resolves.toBe(1);

    expect(mocks.listDue).toHaveBeenCalledWith({
      dueBy: new Date('2026-09-04T17:02:30.000Z'),
    });
    expect(mocks.enqueueFire).toHaveBeenCalledTimes(2);
  });
});

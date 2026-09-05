const mocks = vi.hoisted(() => ({
  acquireTurnLock: vi.fn(),
  enqueueParentEvent: vi.fn(),
  updateWhere: vi.fn(),
  insertOnConflict: vi.fn(),
  insertReturning: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  FAST_AGENT_DURABLE_TURN_CLAIM_MS: 15 * 60 * 1000,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...values) => values),
  eq: vi.fn((...values) => values),
  ne: vi.fn((...values) => values),
  isNull: vi.fn((value) => value),
  fastAgentParentEvents: {
    id: 'id',
    conversationId: 'conversationId',
    eventKey: 'eventKey',
    admission: 'admission',
    claimedUntil: 'claimedUntil',
    deliveredAt: 'deliveredAt',
    discardedAt: 'discardedAt',
  },
  db: (() => {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoNothing: mocks.insertOnConflict })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: mocks.updateWhere })),
      })),
      query: { fastAgentParentEvents: { findFirst: mocks.findFirst } },
    };
    return {
      ...tx,
      transaction: vi.fn(async (run: (client: unknown) => unknown) => run(tx)),
    };
  })(),
}));

vi.mock('./fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueParentEvent,
  buildFastAgentParentEventKey: vi.fn(() => 'stable-event-key'),
}));

import {
  admitFastAgentHumanFollowUp,
  persistFastAgentInlineHumanTurn,
} from './fast-agent-human-follow-up';

const parent = {
  sessionId: '6fc32773-659b-467a-8497-0f2bd94712b0',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'team-1',
    conversationId: '100.1',
    replyTarget: { channelId: 'channel-1', threadId: '100.1' },
  },
};
const event = {
  type: 'human_follow_up' as const,
  eventId: '100.2',
  currentMessageId: '100.2',
  userId: 'user-1',
  question: 'Change direction.',
};

describe('persistFastAgentInlineHumanTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.insertOnConflict.mockReturnValue({
      returning: mocks.insertReturning,
    });
    mocks.insertReturning.mockResolvedValue([{ id: 'row-1' }]);
  });

  it('persists the turn under an inline claim and supersedes older pending inline rows', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'row-1',
      admission: 'inline',
      deliveredAt: null,
      discardedAt: null,
    });

    await expect(
      persistFastAgentInlineHumanTurn({ parent, event }),
    ).resolves.toEqual({ id: 'row-1', eventKey: 'stable-event-key' });
    expect(mocks.insertOnConflict).toHaveBeenCalledOnce();
    // The supersede sweep runs once the row is known to be pending.
    expect(mocks.updateWhere).toHaveBeenCalledOnce();
  });

  it('reports a still-pending inline row as a resumption and refreshes its claim', async () => {
    // The insert hit the existing row: an earlier inline attempt admitted
    // this same turn and never settled it.
    mocks.insertReturning.mockResolvedValue([]);
    mocks.findFirst.mockResolvedValue({
      id: 'row-1',
      admission: 'inline',
      deliveredAt: null,
      discardedAt: null,
    });

    await expect(
      persistFastAgentInlineHumanTurn({ parent, event }),
    ).resolves.toEqual({
      id: 'row-1',
      eventKey: 'stable-event-key',
      resumed: true,
    });
    // Claim refresh, then the supersede sweep.
    expect(mocks.updateWhere).toHaveBeenCalledTimes(2);
  });

  it('does not report a queued row that has not run yet as a resumption', async () => {
    mocks.insertReturning.mockResolvedValue([]);
    mocks.findFirst.mockResolvedValue({
      id: 'row-1',
      admission: 'queued',
      deliveredAt: null,
      discardedAt: null,
    });

    await expect(
      persistFastAgentInlineHumanTurn({ parent, event }),
    ).resolves.toEqual({ id: 'row-1', eventKey: 'stable-event-key' });
    expect(mocks.updateWhere).toHaveBeenCalledOnce();
  });

  it('does not let a reaction supersede a parked or interrupted turn', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'row-1',
      admission: 'inline',
      deliveredAt: null,
      discardedAt: null,
    });

    await expect(
      persistFastAgentInlineHumanTurn({
        parent,
        event: {
          ...event,
          input: {
            type: 'reaction',
            externalInput: {
              type: 'reaction_added',
              provider: 'slack',
              reactions: [{ name: 'thumbsup' }],
              reactor: { externalUserId: 'user-1' },
              message: {
                workspaceId: 'team-1',
                channelId: 'channel-1',
                messageId: '100.1',
                threadId: '100.1',
                text: 'Earlier message',
              },
              eventId: '100.3',
            },
          },
        },
      }),
    ).resolves.toEqual({ id: 'row-1', eventKey: 'stable-event-key' });
    // The reaction's own row is persisted, but the older pending inline row
    // (a turn parked for a retry or waiting to resume) is left alone.
    expect(mocks.insertOnConflict).toHaveBeenCalledOnce();
    expect(mocks.updateWhere).not.toHaveBeenCalled();
  });

  it('does not let a platform event supersede a parked or interrupted turn', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'row-1',
      admission: 'inline',
      deliveredAt: null,
      discardedAt: null,
    });

    await expect(
      persistFastAgentInlineHumanTurn({
        parent,
        event: {
          ...event,
          turnSource: 'platform_event',
          platformEventKind: 'delegated_task',
          setupSession: true,
        },
      }),
    ).resolves.toEqual({ id: 'row-1', eventKey: 'stable-event-key' });
    expect(mocks.updateWhere).not.toHaveBeenCalled();
  });

  it('returns no durable handle when the same message already settled', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'row-1',
      deliveredAt: new Date(),
      discardedAt: null,
    });

    await expect(
      persistFastAgentInlineHumanTurn({ parent, event }),
    ).resolves.toBeNull();
    expect(mocks.updateWhere).not.toHaveBeenCalled();
  });
});

describe('admitFastAgentHumanFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.insertOnConflict.mockReturnValue({
      returning: mocks.insertReturning,
    });
    mocks.insertReturning.mockResolvedValue([{ id: 'row-1' }]);
    mocks.findFirst.mockResolvedValue({
      id: 'row-1',
      admission: 'inline',
      deliveredAt: null,
      discardedAt: null,
    });
  });

  it('runs the turn inline with durable admission when the conversation is idle', async () => {
    const turnLock = vi.fn();
    mocks.acquireTurnLock.mockResolvedValue(turnLock);

    await expect(
      admitFastAgentHumanFollowUp({ parent, event }),
    ).resolves.toEqual({
      kind: 'turn',
      turnLock,
      durable: { id: 'row-1', eventKey: 'stable-event-key' },
    });
    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('still runs the turn inline when durable admission cannot be persisted', async () => {
    const turnLock = vi.fn();
    mocks.acquireTurnLock.mockResolvedValue(turnLock);
    mocks.insertReturning.mockRejectedValue(new Error('db offline'));

    await expect(
      admitFastAgentHumanFollowUp({ parent, event }),
    ).resolves.toEqual({ kind: 'turn', turnLock, durable: null });
  });

  it('durably deduplicates a follow-up before native steering when busy', async () => {
    mocks.acquireTurnLock.mockResolvedValue(null);
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'stable-event-key',
      queued: true,
    });

    const admission = await admitFastAgentHumanFollowUp({ parent, event });

    expect(admission.kind).toBe('steered');
    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({ parent, event });
    if (admission.kind === 'steered') await admission.abort();
    expect(mocks.updateWhere).toHaveBeenCalled();
  });

  it('persists directly to the durable queue when queueing is required', async () => {
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'stable-event-key',
      queued: true,
    });

    await expect(
      admitFastAgentHumanFollowUp({ parent, event, forceQueue: true }),
    ).resolves.toEqual({
      kind: 'queued',
      abort: expect.any(Function),
    });
    expect(mocks.acquireTurnLock).not.toHaveBeenCalled();
    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({ parent, event });
  });
});

const mocks = vi.hoisted(() => ({
  acquireTurnLock: vi.fn(),
  enqueueParentEvent: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...values) => values),
  eq: vi.fn((...values) => values),
  isNull: vi.fn((value) => value),
  fastAgentParentEvents: {
    eventKey: 'eventKey',
    deliveredAt: 'deliveredAt',
    discardedAt: 'discardedAt',
  },
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: mocks.updateWhere })),
    })),
  },
}));

vi.mock('./fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueParentEvent,
}));

import { admitFastAgentHumanFollowUp } from './fast-agent-human-follow-up';

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

describe('admitFastAgentHumanFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateWhere.mockResolvedValue(undefined);
  });

  it('uses the normal turn path when the conversation is idle', async () => {
    const turnLock = vi.fn();
    mocks.acquireTurnLock.mockResolvedValue(turnLock);

    await expect(
      admitFastAgentHumanFollowUp({ parent, event }),
    ).resolves.toEqual({ kind: 'turn', turnLock });
    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('durably deduplicates a follow-up for a subsequent turn when busy', async () => {
    mocks.acquireTurnLock.mockResolvedValue(null);
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'stable-event-key',
      queued: true,
    });

    const admission = await admitFastAgentHumanFollowUp({ parent, event });

    expect(admission.kind).toBe('queued');
    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({ parent, event });
    if (admission.kind === 'queued') await admission.abort();
    expect(mocks.updateWhere).toHaveBeenCalled();
  });
});

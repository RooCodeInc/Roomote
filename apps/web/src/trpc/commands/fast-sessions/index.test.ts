const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  acquireTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  dispatchReviewAction: vi.fn(),
  findAccessibleSession: vi.fn(),
  claimReviewAction: vi.fn(),
  completeReviewAction: vi.fn(),
  releaseReviewAction: vi.fn(),
  retireReviewActions: vi.fn(),
  updateOfferStatus: vi.fn(),
  buildReplyDelivery: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  createFastAgentWebTaskLauncher: vi.fn(),
  getOrCreateFastAgentSession: vi.fn(),
  resolveApiBaseUrl: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  buildFastAgentSurfaceReplyDelivery: mocks.buildReplyDelivery,
  dispatchPrReviewFollowUp: mocks.dispatchReviewAction,
  resolveUserMcpServerConfigs: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  claimCanonicalPrReviewAction: mocks.claimReviewAction,
  completeCanonicalPrReviewActionDispatch: mocks.completeReviewAction,
  releaseCanonicalPrReviewActionDispatch: mocks.releaseReviewAction,
  retireCanonicalPrReviewActionsForDestinationKey: mocks.retireReviewActions,
  eq: vi.fn(),
  fastAgentConversations: {},
  getSessionForFastConversation: vi.fn(),
}));

vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mocks.findAccessibleSession,
  buildFastSessionPrReviewDestinationKey: () => '["web","user-1","session-1"]',
  getFastSessionTasks: vi.fn(),
  updateFastSessionPrReviewOfferStatus: mocks.updateOfferStatus,
}));

import {
  handleFastSessionPrReviewActionCommand,
  replyToFastSessionCommand,
  scheduleWebFastAgentTurn,
} from './index';

const auth = {
  userId: 'user-1',
  isAdmin: false,
  name: 'User One',
  primaryEmail: 'user@example.com',
} as never;

const session = {
  id: '22222222-2222-4222-8222-222222222222',
  userId: 'user-1',
  surface: 'web',
  workspaceId: 'user-1',
  conversationId: 'session-1',
  model: null,
  reasoningEffort: null,
};

describe('scheduleWebFastAgentTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the complete Fast turn in the request post-response lifecycle', async () => {
    let scheduled: (() => Promise<void>) | undefined;
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
    });
    mocks.after.mockImplementation((callback) => {
      scheduled = callback;
    });
    mocks.acquireTurnLock.mockResolvedValue(release);
    mocks.answerQuestion.mockResolvedValue('Recovered response');

    scheduleWebFastAgentTurn({
      userId: 'user-1',
      delivery: {
        conversation: {
          surface: 'web',
          workspaceId: 'user-1',
          conversationId: 'session-1',
        },
        adapter: { launchTask: vi.fn(), postReply: vi.fn() },
      },
      question: 'Try again',
    });

    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.acquireTurnLock).not.toHaveBeenCalled();

    await scheduled?.();

    expect(mocks.answerQuestion).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('Fast session PR review actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAccessibleSession.mockResolvedValue(session);
    mocks.updateOfferStatus.mockResolvedValue(undefined);
  });

  it('claims and dispatches a canonical offer once', async () => {
    mocks.claimReviewAction.mockResolvedValue({
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
    });
    mocks.dispatchReviewAction.mockResolvedValue({
      outcome: 'queued',
      runId: 42,
    });

    await expect(
      handleFastSessionPrReviewActionCommand(auth, {
        sessionId: session.id,
        deliveryId: '11111111-1111-4111-8111-111111111111',
        choice: 'yes',
      }),
    ).resolves.toEqual({ status: 'resolved' });
    expect(mocks.claimReviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actingUserId: 'user-1',
        expectedDestinationKind: 'fast_conversation',
        expectedDestinationKey: '["web","user-1","session-1"]',
      }),
    );
    expect(mocks.dispatchReviewAction).toHaveBeenCalledWith({
      provider: 'web',
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
      actingUserId: 'user-1',
      idempotencyKey: 'pr-review-delivery:11111111-1111-4111-8111-111111111111',
    });
    expect(mocks.completeReviewAction).toHaveBeenCalledWith({
      deliveryId: '11111111-1111-4111-8111-111111111111',
      runId: 42,
    });
  });

  it('retires a duplicate or late action without dispatching', async () => {
    mocks.claimReviewAction.mockResolvedValue(null);
    await expect(
      handleFastSessionPrReviewActionCommand(auth, {
        sessionId: session.id,
        deliveryId: '11111111-1111-4111-8111-111111111111',
        choice: 'dismiss',
      }),
    ).resolves.toEqual({ status: 'stale' });
    expect(mocks.dispatchReviewAction).not.toHaveBeenCalled();
    expect(mocks.updateOfferStatus).toHaveBeenCalledWith(
      session.id,
      ['11111111-1111-4111-8111-111111111111'],
      'stale',
    );
  });

  it('releases the offer when the task cannot be steered', async () => {
    mocks.claimReviewAction.mockResolvedValue({
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
    });
    mocks.dispatchReviewAction.mockResolvedValue({ outcome: 'unavailable' });
    mocks.releaseReviewAction.mockResolvedValue(true);

    await expect(
      handleFastSessionPrReviewActionCommand(auth, {
        sessionId: session.id,
        deliveryId: '11111111-1111-4111-8111-111111111111',
        choice: 'yes',
      }),
    ).resolves.toEqual({ status: 'pending' });
    expect(mocks.releaseReviewAction).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(mocks.updateOfferStatus).toHaveBeenCalledWith(
      session.id,
      ['11111111-1111-4111-8111-111111111111'],
      'pending',
    );
    expect(mocks.completeReviewAction).not.toHaveBeenCalled();
  });

  it('retires open offers when the user types a reply', async () => {
    mocks.retireReviewActions.mockResolvedValue([
      '11111111-1111-4111-8111-111111111111',
    ]);
    mocks.buildReplyDelivery.mockResolvedValue({
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: 'session-1',
      },
      adapter: { launchTask: vi.fn(), postReply: vi.fn() },
    });

    await replyToFastSessionCommand(auth, {
      sessionId: session.id,
      text: 'I will handle this another way.',
    });

    expect(mocks.retireReviewActions).toHaveBeenCalledWith({
      destinationKind: 'fast_conversation',
      destinationKey: '["web","user-1","session-1"]',
    });
    expect(mocks.updateOfferStatus).toHaveBeenCalledWith(
      session.id,
      ['11111111-1111-4111-8111-111111111111'],
      'dismissed',
    );
  });
});

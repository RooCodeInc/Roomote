const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  acquireTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  findAccessibleSession: vi.fn(),
  getOfferStatus: vi.fn(),
  handleReviewAction: vi.fn(),
  retireReviewActions: vi.fn(),
  updateOfferStatus: vi.fn(),
  buildReplyDelivery: vi.fn(),
  createWebTaskLauncher: vi.fn(),
  getOrCreateSession: vi.fn(),
  getUnifiedSession: vi.fn(),
  dbUpdate: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  createFastAgentWebTaskLauncher: mocks.createWebTaskLauncher,
  getOrCreateFastAgentSession: mocks.getOrCreateSession,
  resolveApiBaseUrl: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  buildFastAgentSurfaceReplyDelivery: mocks.buildReplyDelivery,
  resolveUserMcpServerConfigs: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { update: mocks.dbUpdate },
  retireCanonicalPrReviewActionsForDestinationKey: mocks.retireReviewActions,
  eq: vi.fn(),
  fastAgentConversations: {},
  getSessionForFastConversation: mocks.getUnifiedSession,
}));

vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mocks.findAccessibleSession,
  buildFastSessionPrReviewDestinationKey: () => '["web","user-1","session-1"]',
  getFastSessionPrReviewOfferStatus: mocks.getOfferStatus,
  getFastSessionTasks: vi.fn(),
  updateFastSessionPrReviewOfferStatus: mocks.updateOfferStatus,
}));

vi.mock('@/lib/server/pr-review-actions', () => ({
  handleWebPrReviewAction: mocks.handleReviewAction,
}));

import {
  handleFastSessionPrReviewActionCommand,
  replyToFastSessionCommand,
  scheduleWebFastAgentTurn,
  startFastSessionCommand,
  updateFastSessionModelSelectionCommand,
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
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbSet });
    mocks.dbSet.mockReturnValue({ where: mocks.dbWhere });
    mocks.dbWhere.mockResolvedValue(undefined);
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

  it('persists an explicit model selection before the next turn', async () => {
    mocks.findAccessibleSession.mockResolvedValue({
      id: 'fast-session-1',
      model: null,
      reasoningEffort: null,
    });

    await expect(
      updateFastSessionModelSelectionCommand(auth, {
        sessionId: '00000000-0000-4000-8000-000000000000',
        model: 'openrouter/z-ai/glm-5.2',
        reasoningEffort: 'high',
      }),
    ).resolves.toEqual({ success: true });

    expect(mocks.dbSet).toHaveBeenCalledWith({
      model: 'openrouter/z-ai/glm-5.2',
      reasoningEffort: 'high',
    });
  });
});

describe('startFastSessionCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWebTaskLauncher.mockReturnValue(vi.fn());
    mocks.getUnifiedSession.mockResolvedValue({ id: 'unified-session-1' });
    mocks.getOrCreateSession.mockResolvedValue({
      id: 'fast-session-1',
      created: true,
    });
  });

  it('recovers an idempotent Session without scheduling its first turn twice', async () => {
    const input = {
      text: 'Review the starter prompt',
      conversationId: 'setup-starter:batch-1:speed-up-ci',
    };

    await expect(startFastSessionCommand(auth, input)).resolves.toEqual({
      sessionId: 'unified-session-1',
      fastConversationId: 'fast-session-1',
    });
    mocks.getOrCreateSession.mockResolvedValueOnce({
      id: 'fast-session-1',
      created: false,
    });
    await expect(startFastSessionCommand(auth, input)).resolves.toEqual({
      sessionId: 'unified-session-1',
      fastConversationId: 'fast-session-1',
    });

    expect(mocks.getOrCreateSession).toHaveBeenCalledTimes(2);
    expect(mocks.getOrCreateSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'web',
        workspaceId: 'user-1',
        conversationId: input.conversationId,
      },
    });
    expect(mocks.after).toHaveBeenCalledOnce();
  });
});

describe('Fast session PR review actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAccessibleSession.mockResolvedValue(session);
    mocks.updateOfferStatus.mockResolvedValue(undefined);
  });

  it('delegates an authorized offer to the shared web action lifecycle', async () => {
    mocks.handleReviewAction.mockResolvedValue({ status: 'resolved' });

    await expect(
      handleFastSessionPrReviewActionCommand(auth, {
        sessionId: session.id,
        deliveryId: '11111111-1111-4111-8111-111111111111',
        choice: 'yes',
      }),
    ).resolves.toEqual({ status: 'resolved' });
    expect(mocks.handleReviewAction).toHaveBeenCalledWith({
      deliveryId: '11111111-1111-4111-8111-111111111111',
      choice: 'yes',
      actingUserId: 'user-1',
      expectedDestinationKind: 'fast_conversation',
      expectedDestinationKey: '["web","user-1","session-1"]',
      getOfferStatus: expect.any(Function),
      updateOfferStatus: expect.any(Function),
    });
    const [{ getOfferStatus, updateOfferStatus }] =
      mocks.handleReviewAction.mock.calls[0]!;
    mocks.getOfferStatus.mockResolvedValue('resolved');
    await expect(getOfferStatus()).resolves.toBe('resolved');
    expect(mocks.getOfferStatus).toHaveBeenCalledWith(
      session.id,
      '11111111-1111-4111-8111-111111111111',
    );
    await updateOfferStatus('resolved');
    expect(mocks.updateOfferStatus).toHaveBeenCalledWith(
      session.id,
      ['11111111-1111-4111-8111-111111111111'],
      'resolved',
    );
  });

  it('rejects inaccessible sessions before entering the shared lifecycle', async () => {
    mocks.findAccessibleSession.mockResolvedValue(null);

    await expect(
      handleFastSessionPrReviewActionCommand(auth, {
        sessionId: session.id,
        deliveryId: '11111111-1111-4111-8111-111111111111',
        choice: 'yes',
      }),
    ).rejects.toThrow('Fast session not found');
    expect(mocks.handleReviewAction).not.toHaveBeenCalled();
    expect(mocks.updateOfferStatus).not.toHaveBeenCalled();
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

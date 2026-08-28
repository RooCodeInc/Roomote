const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  acquireTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  dbUpdate: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
  findAccessibleFastSession: vi.fn(),
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
  buildFastAgentSurfaceReplyDelivery: vi.fn(),
  resolveUserMcpServerConfigs: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { update: mocks.dbUpdate },
  eq: vi.fn(),
  fastAgentConversations: {},
}));

vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: mocks.findAccessibleFastSession,
}));

import {
  scheduleWebFastAgentTurn,
  updateFastSessionModelSelectionCommand,
} from './index';

const auth = {
  userId: 'user-1',
  name: 'Test User',
  primaryEmail: 'test@example.com',
} as never;

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
    mocks.findAccessibleFastSession.mockResolvedValue({
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

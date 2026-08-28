const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  acquireTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  dbUpdate: vi.fn(),
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
  findAccessibleFastSession: vi.fn(),
}));

import { buildFastAgentSurfaceReplyDelivery } from '@roomote/sdk/server';
import { findAccessibleFastSession } from '@/lib/server/fast-sessions';

import { replyToFastSessionCommand, scheduleWebFastAgentTurn } from './index';

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

describe('replyToFastSessionCommand', () => {
  it('rejects staged automation-owned sessions before persisting settings', async () => {
    vi.mocked(findAccessibleFastSession).mockResolvedValue({
      id: 'session-1',
      userId: null,
      ownerAutomation: 'announcer',
      title: null,
      surface: 'automation',
      workspaceId: 'announcer',
      conversationId: 'occurrence-1',
      model: null,
      reasoningEffort: null,
    });

    await expect(
      replyToFastSessionCommand(
        {
          success: true,
          userId: 'admin-1',
          name: 'Admin',
          primaryEmail: 'admin@example.com',
          isAdmin: true,
        } as never,
        {
          sessionId: 'session-1',
          text: 'Continue',
          model: 'openai/gpt-5.6',
          reasoningEffort: 'high',
        },
      ),
    ).rejects.toThrow('read-only until the next release');
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(buildFastAgentSurfaceReplyDelivery).not.toHaveBeenCalled();
  });
});

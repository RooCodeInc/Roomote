import { RunStatus } from '@roomote/types';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  getOrCreateFastAgentSession: vi.fn(),
  getSessionForTask: vi.fn(),
  admitFastAgentHumanFollowUp: vi.fn(),
  queueFastAgentSurfaceReply: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  fastAgentConversationRepository: { findById: mocks.findById },
  getOrCreateFastAgentSession: mocks.getOrCreateFastAgentSession,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getSessionForTask: mocks.getSessionForTask,
}));

vi.mock('./fast-agent-human-follow-up', () => ({
  admitFastAgentHumanFollowUp: mocks.admitFastAgentHumanFollowUp,
}));

vi.mock('./fast-agent-surface-reply', () => ({
  queueFastAgentSurfaceReply: mocks.queueFastAgentSurfaceReply,
}));

vi.mock('@roomote/communication', () => ({
  buildFastSessionReplyFooterText: vi.fn(() => ''),
  resolveFastSessionLivePreviewUrl: vi.fn(async () => null),
}));

import { startSourceControlFastSessionTurn } from './source-control-fast-session';
import type { SourceControlFastDiscussion } from './source-control-fast-delivery';

const discussion: SourceControlFastDiscussion = {
  provider: 'github',
  host: 'github.com',
  repositoryFullName: 'acme/api',
  kind: 'pull',
  number: 42,
  reviewCommentId: '800',
};

const slackConversation = {
  surface: 'slack' as const,
  workspaceId: 'T1',
  conversationId: 'C1:100.000',
  replyTarget: { channelId: 'C1', threadId: '100.000' },
};

const baseInput = {
  discussion,
  userId: 'user-1',
  senderDisplayName: 'alice',
  question: 'Can you also update the changelog?',
  agentContext: '<pull_request>#42</pull_request>',
  currentMessageId: 'github:comment:900',
};

describe('startSourceControlFastSessionTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateFastAgentSession.mockResolvedValue({ id: 'pr-session' });
    mocks.queueFastAgentSurfaceReply.mockResolvedValue(true);
    mocks.admitFastAgentHumanFollowUp.mockResolvedValue({
      kind: 'queued',
      abort: vi.fn(),
    });
  });

  it('joins the Session whose task opened the pull request and answers there and on the pull request', async () => {
    mocks.getSessionForTask.mockResolvedValue({
      id: 'unified-a',
      fastConversationId: 'session-a',
    });
    mocks.findById.mockResolvedValue({
      id: 'session-a',
      conversation: slackConversation,
    });

    const result = await startSourceControlFastSessionTurn({
      ...baseInput,
      sourceUrl: 'https://github.com/acme/api/pull/42#discussion_r900',
      activeTasks: [{ taskId: 'task-owner', status: RunStatus.Running }],
    });

    expect(result).toEqual({
      status: 'queued',
      fastConversationId: 'session-a',
      joinedOwningSession: true,
    });
    expect(mocks.getSessionForTask).toHaveBeenCalledWith({}, 'task-owner');
    expect(mocks.admitFastAgentHumanFollowUp).toHaveBeenCalledWith({
      parent: { sessionId: 'session-a', conversation: slackConversation },
      event: {
        type: 'human_follow_up',
        eventId: 'github:comment:900',
        currentMessageId: 'github:comment:900',
        userId: 'user-1',
        question: 'Can you also update the changelog?',
        senderDisplayName: 'alice',
        agentContext: expect.stringContaining(
          'alice posted this message on GitHub pull request acme/api#42 (https://github.com/acme/api/pull/42#discussion_r900), which a task in this Session opened.',
        ),
        activeTasks: [{ taskId: 'task-owner', status: RunStatus.Running }],
        sourceControlReplyTarget: {
          provider: 'github',
          host: 'github.com',
          repositoryFullName: 'acme/api',
          kind: 'pull',
          number: 42,
          reviewCommentId: '800',
          url: 'https://github.com/acme/api/pull/42#discussion_r900',
        },
      },
      forceQueue: true,
    });
    const event = mocks.admitFastAgentHumanFollowUp.mock.calls[0]?.[0].event;
    expect(event.agentContext).toContain('<pull_request>#42</pull_request>');
    expect(mocks.getOrCreateFastAgentSession).not.toHaveBeenCalled();
    expect(mocks.queueFastAgentSurfaceReply).not.toHaveBeenCalled();
  });

  it('falls back to the discussion URL when the source has no permalink', async () => {
    mocks.getSessionForTask.mockResolvedValue({
      id: 'unified-a',
      fastConversationId: 'session-a',
    });
    mocks.findById.mockResolvedValue({
      id: 'session-a',
      conversation: slackConversation,
    });

    await startSourceControlFastSessionTurn({
      ...baseInput,
      activeTasks: [{ taskId: 'task-owner', status: RunStatus.Running }],
    });

    const event = mocks.admitFastAgentHumanFollowUp.mock.calls[0]?.[0].event;
    expect(event.agentContext).toContain(
      'alice posted this message on GitHub pull request acme/api#42 (https://github.com/acme/api/pull/42), which a task in this Session opened.',
    );
    expect(event.sourceControlReplyTarget.url).toBe(
      'https://github.com/acme/api/pull/42',
    );
  });

  it('stays in the discussion Session when its own task owns the pull request', async () => {
    mocks.getSessionForTask.mockResolvedValue({
      id: 'unified-pr',
      fastConversationId: 'pr-session',
    });
    mocks.findById.mockResolvedValue({
      id: 'pr-session',
      conversation: {
        surface: 'github',
        workspaceId: 'github.com/acme/api',
        conversationId: 'pull/42',
        replyTarget: { channelId: 'pull/42' },
      },
    });

    const result = await startSourceControlFastSessionTurn({
      ...baseInput,
      activeTasks: [{ taskId: 'task-from-pr-session' }],
    });

    expect(result).toEqual({
      status: 'queued',
      fastConversationId: 'pr-session',
    });
    expect(mocks.admitFastAgentHumanFollowUp).not.toHaveBeenCalled();
    expect(mocks.queueFastAgentSurfaceReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'pr-session',
        question: 'Can you also update the changelog?',
        agentContext: '<pull_request>#42</pull_request>',
        activeTasks: [{ taskId: 'task-from-pr-session' }],
      }),
    );
  });

  it('uses the discussion Session when no active task has a Session', async () => {
    mocks.getSessionForTask.mockResolvedValue(null);

    const result = await startSourceControlFastSessionTurn({
      ...baseInput,
      activeTasks: [{ taskId: 'task-review' }],
    });

    expect(result).toEqual({
      status: 'queued',
      fastConversationId: 'pr-session',
    });
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.admitFastAgentHumanFollowUp).not.toHaveBeenCalled();
    expect(mocks.getOrCreateFastAgentSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: expect.objectContaining({
        surface: 'github',
        conversationId: 'pull/42',
      }),
    });
  });

  it('reports the discussion Session as unavailable when the turn is refused', async () => {
    mocks.queueFastAgentSurfaceReply.mockResolvedValue(false);

    await expect(startSourceControlFastSessionTurn(baseInput)).resolves.toEqual(
      { status: 'unavailable' },
    );
    expect(mocks.getSessionForTask).not.toHaveBeenCalled();
  });
});

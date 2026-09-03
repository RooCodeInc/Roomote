const mocks = vi.hoisted(() => ({
  getOrCreateFastAgentSession: vi.fn(),
  getSessionForFastConversation: vi.fn(),
  queueFastAgentSurfaceReply: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getOrCreateFastAgentSession: mocks.getOrCreateFastAgentSession,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getSessionForFastConversation: mocks.getSessionForFastConversation,
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://app.roomote.example' },
}));

vi.mock('./fast-agent-surface-reply', () => ({
  queueFastAgentSurfaceReply: mocks.queueFastAgentSurfaceReply,
}));

vi.mock('./linear-fast-session', () => ({
  buildLinearFastConversation: (input: {
    organizationId: string;
    agentSessionId: string;
  }) => ({
    surface: 'linear',
    workspaceId: input.organizationId,
    conversationId: input.agentSessionId,
    replyTarget: { channelId: input.agentSessionId },
  }),
}));

import type { AgentSessionEventPayload } from '@roomote/linear';

import {
  buildLinearFastTurn,
  startLinearFastSessionTurn,
} from './linear-fast-session-turn';

const issue = {
  id: 'issue-1',
  identifier: 'ENG-123',
  title: 'Fix API retries',
  description: 'Retries never back off.',
  url: 'https://linear.app/acme/issue/ENG-123',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
};

function makePayload(
  overrides: Partial<AgentSessionEventPayload> = {},
): AgentSessionEventPayload {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    organizationId: 'org-1',
    appUserId: 'app-user-1',
    webhookTimestamp: 1_700_000_000_000,
    agentSession: {
      id: 'session-1',
      issue,
      comment: { id: 'comment-1', body: '@roomote fix the retry loop' },
      previousComments: [
        {
          id: 'c-0',
          body: 'Seen in production twice.',
          user: { id: 'u-2', name: 'Sam' },
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      creator: { id: 'u-1', name: 'Dana' },
      guidance: { instructions: 'Prefer small PRs.' },
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
    agentActivity: {
      id: 'activity-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      agentSessionId: 'session-1',
      content: { type: 'prompt', body: '@roomote fix the retry loop' },
    },
    ...overrides,
  } as AgentSessionEventPayload;
}

describe('buildLinearFastTurn', () => {
  it('uses the mention as the question and folds the issue, comments, and guidance into context', () => {
    const payload = makePayload();

    const turn = buildLinearFastTurn({
      payload,
      agentSession: payload.agentSession,
    });

    expect(turn.question).toBe('@roomote fix the retry loop');
    expect(turn.currentMessageId).toBe('activity-1');
    expect(turn.senderDisplayName).toBe('Dana');
    expect(turn.agentContext).toContain(
      '<linear_issue identifier="ENG-123" url="https://linear.app/acme/issue/ENG-123">',
    );
    expect(turn.agentContext).toContain('Retries never back off.');
    expect(turn.agentContext).toContain('Team: Engineering');
    expect(turn.agentContext).toContain('Sam (2026-09-01T00:00:00.000Z):');
    expect(turn.agentContext).toContain('Prefer small PRs.');
  });

  it("treats Linear's delegation stub comment as work on the issue", () => {
    const payload = makePayload({
      agentSession: {
        id: 'session-1',
        issue,
        comment: {
          id: 'comment-stub',
          body: 'This thread is for an agent session with roomoteroomoteroomote.',
        },
        previousComments: [
          {
            id: 'c-stub',
            body: 'This thread is for an agent session with roomoteroomoteroomote.',
            user: { id: 'u-bot', name: 'roomote' },
          },
          {
            id: 'c-real',
            body: 'Seen in production twice.',
            user: { id: 'u-2', name: 'Sam' },
          },
        ],
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
      agentActivity: {
        id: 'activity-1',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
        agentSessionId: 'session-1',
        content: {
          type: 'prompt',
          body: 'This thread is for an agent session with roomoteroomoteroomote.',
        },
      },
    });

    const turn = buildLinearFastTurn({
      payload,
      agentSession: payload.agentSession,
    });

    expect(turn.question).toBe('Work on ENG-123: Fix API retries');
    expect(turn.agentContext).toContain('Retries never back off.');
    expect(turn.agentContext).toContain('Seen in production twice.');
    expect(turn.agentContext).not.toContain('agent session with');
  });

  it('describes a delegation with no comment as work on the issue', () => {
    const payload = makePayload({
      agentSession: {
        id: 'session-1',
        issue,
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
      agentActivity: undefined,
    });

    const turn = buildLinearFastTurn({
      payload,
      agentSession: payload.agentSession,
    });

    expect(turn.question).toBe('Work on ENG-123: Fix API retries');
    expect(turn.currentMessageId).toBe(
      'linear:session-1:created:1700000000000',
    );
    expect(turn.senderDisplayName).toBeNull();
    expect(turn.agentContext).not.toContain('<issue_comments>');
  });

  it('keeps prompted follow-ups to the new message and the issue header', () => {
    const payload = makePayload({
      action: 'prompted',
      agentActivity: {
        id: 'activity-2',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
        agentSessionId: 'session-1',
        content: { type: 'prompt', body: 'Also add a test.' },
      },
    });

    const turn = buildLinearFastTurn({
      payload,
      agentSession: payload.agentSession,
    });

    expect(turn.question).toBe('Also add a test.');
    expect(turn.agentContext).toContain('ENG-123');
    expect(turn.agentContext).not.toContain('Seen in production twice.');
  });
});

describe('startLinearFastSessionTurn', () => {
  const linearClient = {
    updateSessionExternalUrls: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateFastAgentSession.mockResolvedValue({
      id: 'fast-1',
      created: true,
    });
    mocks.getSessionForFastConversation.mockResolvedValue({ id: 'session-9' });
    mocks.queueFastAgentSurfaceReply.mockResolvedValue(true);
    linearClient.updateSessionExternalUrls.mockResolvedValue({
      success: true,
    });
  });

  it('links the Session page on the first turn and queues the turn into Fast', async () => {
    const payload = makePayload();

    const result = await startLinearFastSessionTurn({
      payload,
      agentSession: payload.agentSession,
      userId: 'user-1',
      linearClient: linearClient as never,
    });

    expect(result).toEqual({ status: 'queued', fastConversationId: 'fast-1' });
    expect(mocks.getOrCreateFastAgentSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'linear',
        workspaceId: 'org-1',
        conversationId: 'session-1',
        replyTarget: { channelId: 'session-1' },
      },
    });
    expect(linearClient.updateSessionExternalUrls).toHaveBeenCalledWith(
      'session-1',
      [
        {
          label: 'Open in Roomote',
          url: 'https://app.roomote.example/sessions/session-9',
        },
      ],
    );
    expect(mocks.queueFastAgentSurfaceReply).toHaveBeenCalledWith({
      sessionId: 'fast-1',
      userId: 'user-1',
      senderDisplayName: 'Dana',
      question: '@roomote fix the retry loop',
      agentContext: expect.stringContaining('ENG-123'),
      currentMessageId: 'activity-1',
    });
  });

  it('does not relink an existing conversation and reports an unavailable route', async () => {
    mocks.getOrCreateFastAgentSession.mockResolvedValue({
      id: 'fast-1',
      created: false,
    });
    mocks.queueFastAgentSurfaceReply.mockResolvedValue(false);
    const payload = makePayload({ action: 'prompted' });

    const result = await startLinearFastSessionTurn({
      payload,
      agentSession: payload.agentSession,
      userId: 'user-1',
      linearClient: linearClient as never,
    });

    expect(result).toMatchObject({ status: 'unavailable' });
    expect(linearClient.updateSessionExternalUrls).not.toHaveBeenCalled();
  });
});

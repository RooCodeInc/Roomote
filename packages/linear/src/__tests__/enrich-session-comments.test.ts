import { enrichSessionComments } from '../enrich-session-comments';
import type { LinearClient } from '../linear-client';
import type { AgentSession } from '../types';

function createMockLinearClient(
  getIssueCommentsResult: Awaited<ReturnType<LinearClient['getIssueComments']>>,
): LinearClient {
  return {
    getIssueComments: vi.fn().mockResolvedValue(getIssueCommentsResult),
  } as unknown as LinearClient;
}

function createMockAgentSession(
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    id: 'session-1',
    issue: {
      id: 'issue-1',
      identifier: 'TEST-1',
      title: 'Test Issue',
      url: 'https://linear.app/test/issue/TEST-1',
    },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('enrichSessionComments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should replace previousComments with API-fetched comments', async () => {
    const webhookComments = [
      {
        id: 'comment-1',
        body: 'First comment',
        user: { id: 'user-1', name: 'Alice' },
        createdAt: '2024-01-01T00:00:00Z',
      },
    ];

    const apiComments = [
      {
        id: 'comment-1',
        body: 'First comment',
        user: { id: 'user-1', name: 'Alice' },
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'comment-2',
        body: 'External comment from GitHub',
        user: { id: 'external:comment-2', name: 'GitHub Bot' },
        createdAt: '2024-01-01T01:00:00Z',
      },
      {
        id: 'comment-3',
        body: 'Comment from Slack',
        user: { id: 'external:comment-3', name: 'slack-user' },
        createdAt: '2024-01-01T02:00:00Z',
      },
    ];

    const linearClient = createMockLinearClient({
      success: true,
      comments: apiComments,
    });

    const session = createMockAgentSession({
      previousComments: webhookComments,
    });

    const result = await enrichSessionComments(linearClient, session);

    expect(result.previousComments).toHaveLength(3);
    expect(result.previousComments).toEqual(apiComments);
    expect(linearClient.getIssueComments).toHaveBeenCalledWith('issue-1');
  });

  it('should exclude the triggering comment from enriched results', async () => {
    const apiComments = [
      {
        id: 'comment-1',
        body: 'Previous comment',
        user: { id: 'user-1', name: 'Alice' },
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'comment-trigger',
        body: 'This is the triggering comment',
        user: { id: 'user-2', name: 'Bob' },
        createdAt: '2024-01-01T01:00:00Z',
      },
    ];

    const linearClient = createMockLinearClient({
      success: true,
      comments: apiComments,
    });

    const session = createMockAgentSession({
      comment: {
        id: 'comment-trigger',
        body: 'This is the triggering comment',
        user: { id: 'user-2', name: 'Bob' },
      },
    });

    const result = await enrichSessionComments(linearClient, session);

    expect(result.previousComments).toHaveLength(1);
    expect(result.previousComments?.[0]?.id).toBe('comment-1');
  });

  it('should fall back to webhook previousComments when API fails', async () => {
    const webhookComments = [
      {
        id: 'comment-1',
        body: 'First comment',
        user: { id: 'user-1', name: 'Alice' },
      },
    ];

    const linearClient = createMockLinearClient({
      success: false,
      error: 'API rate limit exceeded',
    });

    const session = createMockAgentSession({
      previousComments: webhookComments,
    });

    const result = await enrichSessionComments(linearClient, session);

    // Should return original session unchanged
    expect(result.previousComments).toEqual(webhookComments);
    expect(result).toBe(session);
  });

  it('should fall back to original session when getIssueComments throws', async () => {
    const webhookComments = [
      {
        id: 'comment-1',
        body: 'First comment',
        user: { id: 'user-1', name: 'Alice' },
      },
    ];

    const linearClient = {
      getIssueComments: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as LinearClient;

    const session = createMockAgentSession({
      previousComments: webhookComments,
    });

    const result = await enrichSessionComments(linearClient, session);

    // Should return original session unchanged
    expect(result.previousComments).toEqual(webhookComments);
    expect(result).toBe(session);
  });

  it('should handle session with no triggering comment', async () => {
    const apiComments = [
      {
        id: 'comment-1',
        body: 'First comment',
        user: { id: 'user-1', name: 'Alice' },
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'comment-2',
        body: 'Second comment',
        user: { id: 'user-2', name: 'Bob' },
        createdAt: '2024-01-01T01:00:00Z',
      },
    ];

    const linearClient = createMockLinearClient({
      success: true,
      comments: apiComments,
    });

    // Session without a triggering comment (e.g., delegation)
    const session = createMockAgentSession();

    const result = await enrichSessionComments(linearClient, session);

    // All comments should be included since there's no triggering comment to exclude
    expect(result.previousComments).toHaveLength(2);
    expect(result.previousComments).toEqual(apiComments);
  });

  it('should handle empty API response', async () => {
    const linearClient = createMockLinearClient({
      success: true,
      comments: [],
    });

    const session = createMockAgentSession({
      previousComments: [
        {
          id: 'comment-1',
          body: 'Webhook comment',
          user: { id: 'user-1', name: 'Alice' },
        },
      ],
    });

    const result = await enrichSessionComments(linearClient, session);

    // API returned empty array - use it (it's authoritative)
    expect(result.previousComments).toHaveLength(0);
  });

  it('should include external user comments', async () => {
    const apiComments = [
      {
        id: 'comment-1',
        body: 'Normal comment',
        user: { id: 'user-1', name: 'Alice' },
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'comment-2',
        body: 'Synced from GitHub issue',
        user: { id: 'external:comment-2', name: 'github-user' },
        createdAt: '2024-01-01T01:00:00Z',
      },
      {
        id: 'comment-3',
        body: 'Bot comment',
        user: { id: 'bot:comment-3', name: 'CI Bot' },
        createdAt: '2024-01-01T02:00:00Z',
      },
    ];

    const linearClient = createMockLinearClient({
      success: true,
      comments: apiComments,
    });

    const session = createMockAgentSession();

    const result = await enrichSessionComments(linearClient, session);

    expect(result.previousComments).toHaveLength(3);
    // Verify external user is captured
    expect(result.previousComments?.[1]?.user?.name).toBe('github-user');
    expect(result.previousComments?.[1]?.user?.id).toBe('external:comment-2');
    // Verify bot is captured
    expect(result.previousComments?.[2]?.user?.name).toBe('CI Bot');
    expect(result.previousComments?.[2]?.user?.id).toBe('bot:comment-3');
  });

  it('should not mutate the original agentSession', async () => {
    const apiComments = [
      {
        id: 'comment-new',
        body: 'New comment',
        user: { id: 'user-1', name: 'Alice' },
        createdAt: '2024-01-01T00:00:00Z',
      },
    ];

    const linearClient = createMockLinearClient({
      success: true,
      comments: apiComments,
    });

    const originalComments = [
      {
        id: 'comment-old',
        body: 'Old comment',
        user: { id: 'user-1', name: 'Alice' },
      },
    ];
    const session = createMockAgentSession({
      previousComments: originalComments,
    });

    const result = await enrichSessionComments(linearClient, session);

    // Original session should be unchanged
    expect(session.previousComments).toEqual(originalComments);
    // Result should have new comments
    expect(result.previousComments).toEqual(apiComments);
    // Should be different object references
    expect(result).not.toBe(session);
  });
});

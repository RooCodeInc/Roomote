const mocks = vi.hoisted(() => ({
  classifyFollowUp: vi.fn(),
  routeTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  classifyFollowUp: mocks.classifyFollowUp,
  routeTask: mocks.routeTask,
}));

import { resolveRoutingFollowUp } from '../routing-follow-up.js';

const routingContext = {
  taskDescription: 'Fix the flaky login test',
  source: {
    type: 'telegram' as const,
    chatName: 'Engineering',
    threadMessages: [{ user: 'Grace', text: 'Fix the flaky login test' }],
  },
  availableEnvironments: [
    { id: 'web', name: 'Web App', repositoryNames: ['acme/web'] },
    { id: 'api', name: 'API', repositoryNames: ['acme/api'] },
  ],
};

describe('resolveRoutingFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('confirms a proposed workspace without routing again', async () => {
    mocks.classifyFollowUp.mockResolvedValueOnce({
      intent: 'confirm',
      reasoning: 'accepted',
    });

    await expect(
      resolveRoutingFollowUp({
        routingContext,
        suggestion: {
          workspace: { type: 'environment', id: 'web', name: 'Web App' },
          workspaceDisplayName: 'Web App',
        },
        userResponse: 'yes',
        userName: 'Grace',
        userId: 'user-1',
      }),
    ).resolves.toEqual({ intent: 'confirm' });
    expect(mocks.routeTask).not.toHaveBeenCalled();
  });

  it('cancels without routing again', async () => {
    mocks.classifyFollowUp.mockResolvedValueOnce({
      intent: 'cancel',
      reasoning: 'stopped',
    });

    await expect(
      resolveRoutingFollowUp({
        routingContext,
        suggestion: {
          workspace: { type: 'environment', id: 'web', name: 'Web App' },
          workspaceDisplayName: 'Web App',
        },
        userResponse: 'never mind',
        userName: 'Grace',
        userId: 'user-1',
      }),
    ).resolves.toEqual({ intent: 'cancel' });
    expect(mocks.routeTask).not.toHaveBeenCalled();
  });

  it('uses the reply as a routing correction while retaining the original request as context', async () => {
    mocks.classifyFollowUp.mockResolvedValueOnce({
      intent: 'correct',
      reasoning: 'different workspace',
    });
    const routingDecision = {
      status: 'routed' as const,
      result: {
        workspace: { type: 'environment' as const, id: 'api', name: 'API' },
        reasoning: 'explicit correction',
      },
    };
    mocks.routeTask.mockResolvedValueOnce(routingDecision);

    await expect(
      resolveRoutingFollowUp({
        routingContext,
        suggestion: {
          workspace: { type: 'environment', id: 'web', name: 'Web App' },
          workspaceDisplayName: 'Web App',
        },
        userResponse: 'use API instead',
        userName: 'Grace',
        userId: 'user-1',
      }),
    ).resolves.toEqual({ intent: 'correct', routingDecision });
    expect(mocks.routeTask).toHaveBeenCalledWith({
      ...routingContext,
      taskDescription: 'use API instead',
      source: {
        ...routingContext.source,
        threadMessages: [
          { user: 'Grace', text: 'Fix the flaky login test' },
          { user: 'Grace', text: 'use API instead' },
        ],
      },
      previousSuggestion: {
        workspaceValue: 'web',
        workspaceDisplayName: 'Web App',
      },
    });
  });

  it('does not confirm when the card is a picker with no suggestion', async () => {
    mocks.classifyFollowUp.mockResolvedValueOnce({
      intent: 'confirm',
      reasoning: 'ambiguous agreement',
    });
    mocks.routeTask.mockResolvedValueOnce({
      status: 'fallback',
      reason: 'still ambiguous',
    });

    const result = await resolveRoutingFollowUp({
      routingContext,
      suggestion: null,
      userResponse: 'yes',
      userName: 'Grace',
      userId: 'user-1',
    });

    expect(result.intent).toBe('correct');
    expect(mocks.routeTask).toHaveBeenCalledOnce();
  });
});

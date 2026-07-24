const mocks = vi.hoisted(() => ({
  classifyFollowUp: vi.fn(),
  recordUserRoutingPreference: vi.fn(),
  routeTask: vi.fn(),
}));

vi.mock('../router-service', () => ({
  classifyFollowUp: mocks.classifyFollowUp,
  routeTask: mocks.routeTask,
}));

vi.mock('@roomote/db/server', () => ({
  recordUserRoutingPreference: mocks.recordUserRoutingPreference,
}));

import { resolveRoutingFollowUp } from '../follow-up-service';

const routingContext = {
  taskDescription: 'use API instead',
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

  it('confirms a proposed workspace without building context or routing again', async () => {
    mocks.classifyFollowUp.mockResolvedValueOnce({
      intent: 'confirm',
      reasoning: 'accepted',
    });
    const buildCorrectionContext = vi.fn();

    await expect(
      resolveRoutingFollowUp({
        suggestion: {
          workspaceValue: 'web',
          workspaceDisplayName: 'Web App',
        },
        userResponse: 'yes',
        userId: 'user-1',
        buildCorrectionContext,
      }),
    ).resolves.toEqual({ intent: 'confirm' });
    expect(buildCorrectionContext).not.toHaveBeenCalled();
    expect(mocks.routeTask).not.toHaveBeenCalled();
  });

  it('cancels without building context or routing again', async () => {
    mocks.classifyFollowUp.mockResolvedValueOnce({
      intent: 'cancel',
      reasoning: 'stopped',
    });
    const buildCorrectionContext = vi.fn();

    await expect(
      resolveRoutingFollowUp({
        suggestion: {
          workspaceValue: 'web',
          workspaceDisplayName: 'Web App',
        },
        userResponse: 'never mind',
        userId: 'user-1',
        buildCorrectionContext,
      }),
    ).resolves.toEqual({ intent: 'cancel' });
    expect(buildCorrectionContext).not.toHaveBeenCalled();
    expect(mocks.routeTask).not.toHaveBeenCalled();
  });

  it('routes a correction with the previous suggestion and reply in context', async () => {
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
        suggestion: {
          workspaceValue: 'web',
          workspaceDisplayName: 'Web App',
        },
        userResponse: 'use API instead',
        userId: 'user-1',
        correctionMessage: { user: 'Grace', text: 'use API instead' },
        buildCorrectionContext: async () => routingContext,
      }),
    ).resolves.toEqual({ intent: 'correct', routingDecision });
    expect(mocks.routeTask).toHaveBeenCalledWith({
      ...routingContext,
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
    expect(mocks.recordUserRoutingPreference).toHaveBeenCalledWith({
      userId: 'user-1',
      environmentId: 'api',
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
      suggestion: null,
      userResponse: 'yes',
      userId: 'user-1',
      buildCorrectionContext: async () => routingContext,
    });

    expect(result.intent).toBe('correct');
    expect(mocks.routeTask).toHaveBeenCalledOnce();
  });

  it('does not persist memory when follow-up classification falls back', async () => {
    mocks.classifyFollowUp.mockResolvedValueOnce({
      intent: 'correct',
      reasoning: 'Classification failed',
      isFallback: true,
    });
    mocks.routeTask.mockResolvedValueOnce({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'api', name: 'API' },
        reasoning: 'fallback reroute',
      },
    });

    await resolveRoutingFollowUp({
      suggestion: {
        workspaceValue: 'web',
        workspaceDisplayName: 'Web App',
      },
      userResponse: 'yes',
      userId: 'user-1',
      buildCorrectionContext: async () => routingContext,
    });

    expect(mocks.recordUserRoutingPreference).not.toHaveBeenCalled();
  });
});

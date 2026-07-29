import { ALL_REPOSITORIES } from '@roomote/types';

const {
  buildLinearRoutingContextMock,
  routeTaskMock,
  deletePendingSelectionMock,
  startElicitationFallbackMock,
} = vi.hoisted(() => ({
  buildLinearRoutingContextMock: vi.fn(),
  routeTaskMock: vi.fn(),
  deletePendingSelectionMock: vi.fn(),
  startElicitationFallbackMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildLinearRoutingContext: buildLinearRoutingContextMock,
  routeTask: routeTaskMock,
}));

vi.mock('./elicitation-fallback', () => ({
  deletePendingSelection: deletePendingSelectionMock,
  startElicitationFallback: startElicitationFallbackMock,
  stripEmojiPrefix: (value: string) => value.replace(/^\p{Emoji}\s*/u, ''),
}));

import type { LinearClient } from './linear-client';
import { resolveLinearTaskDestination } from './resolve-task-destination';
import type { AgentSessionEventPayload } from './types';

function makePayload(): AgentSessionEventPayload {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    organizationId: 'linear-org-1',
    appUserId: 'linear-app-user-1',
    webhookTimestamp: Date.now(),
    webhookId: 'webhook-1',
    agentSession: {
      id: 'session-1',
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix API retries',
        description: 'Retry failed requests from the API',
        url: 'https://linear.example/ENG-123',
        project: { id: 'project-1', name: 'Reliability' },
        team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
      },
      comment: {
        id: 'comment-2',
        body: 'Please fix the retry behavior',
        user: { id: 'linear-user-1', name: 'Daniel' },
      },
      previousComments: [
        {
          id: 'comment-1',
          body: 'This belongs in the API service',
          user: { id: 'linear-user-2', name: 'Matt' },
        },
      ],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    },
  };
}

describe('resolveLinearTaskDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLinearRoutingContextMock.mockResolvedValue({ source: 'linear' });
  });

  it('returns the environment selected by the router', async () => {
    routeTaskMock.mockResolvedValue({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'env-api', name: 'API' },
        kickoffMessage: 'I will inspect the retry path.',
        reasoning: 'The issue explicitly refers to the API service.',
        debug: { stages: [] },
      },
    });
    const payload = makePayload();

    const result = await resolveLinearTaskDestination({
      payload,
      agentSession: payload.agentSession,
      userId: 'roomote-user-1',
      linearClient: {} as LinearClient,
      apiBaseUrl: 'https://api.roomote.example',
    });

    expect(buildLinearRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'roomote-user-1',
        taskDescription: 'Please fix the retry behavior',
        issueIdentifier: 'ENG-123',
        projectName: 'Reliability',
        teamName: 'Engineering',
        previousComments: [
          {
            body: 'This belongs in the API service',
            username: 'Matt',
          },
        ],
        apiBaseUrl: 'https://api.roomote.example',
      }),
    );
    expect(result).toMatchObject({
      status: 'routed',
      destination: {
        workspaceSelection: { environmentId: 'env-api' },
        workspaceDisplayName: 'API',
        workspaceType: 'environment',
        kickoffMessage: 'I will inspect the retry path.',
        reasoning: 'The issue explicitly refers to the API service.',
      },
    });
    expect(startElicitationFallbackMock).not.toHaveBeenCalled();
  });

  it('waits for a workspace choice when routing cannot decide', async () => {
    routeTaskMock.mockResolvedValue({
      status: 'fallback',
      reason: 'No confident workspace match',
    });
    startElicitationFallbackMock.mockResolvedValue({
      status: 'ok',
      pendingSelection: { step: 'awaiting_workspace' },
    });
    const payload = makePayload();
    const linearClient = {} as LinearClient;

    const result = await resolveLinearTaskDestination({
      payload,
      agentSession: payload.agentSession,
      userId: 'roomote-user-1',
      linearClient,
      apiBaseUrl: 'https://api.roomote.example',
    });

    expect(result).toEqual({ status: 'awaiting_selection' });
    expect(startElicitationFallbackMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      linearOrganizationId: 'linear-org-1',
      userId: 'roomote-user-1',
      payload,
      linearClient,
    });
  });

  it('uses all repositories for an automation when routing is unavailable', async () => {
    routeTaskMock.mockRejectedValue(new Error('router unavailable'));
    const payload = makePayload();

    const result = await resolveLinearTaskDestination({
      payload,
      agentSession: payload.agentSession,
      linearClient: {} as LinearClient,
      apiBaseUrl: 'https://api.roomote.example',
    });

    expect(result).toEqual({
      status: 'routed',
      destination: {
        workspaceSelection: { repo: ALL_REPOSITORIES },
        workspaceDisplayName: 'all repos',
        workspaceType: 'all_repositories',
      },
    });
    expect(startElicitationFallbackMock).not.toHaveBeenCalled();
  });
});

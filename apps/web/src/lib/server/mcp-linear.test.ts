const {
  dbUpdateMock,
  consumeMcpOauthReplayMock,
  createLinearAgentRunMock,
  emitThoughtMock,
  payload,
  resolveLinearTaskDestinationMock,
  updateSessionExternalUrlsMock,
} = vi.hoisted(() => ({
  dbUpdateMock: vi.fn(),
  consumeMcpOauthReplayMock: vi.fn(),
  createLinearAgentRunMock: vi.fn(),
  emitThoughtMock: vi.fn(),
  payload: {
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
        description: 'Retry failed API requests',
        url: 'https://linear.example/ENG-123',
      },
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    },
  },
  resolveLinearTaskDestinationMock: vi.fn(),
  updateSessionExternalUrlsMock: vi.fn(),
}));

vi.mock('@linear/sdk', () => ({
  LinearClient: class {
    viewer = Promise.resolve({
      id: 'linear-user-1',
      organization: Promise.resolve({
        id: 'linear-org-1',
        name: 'Linear Test',
        urlKey: 'linear-test',
      }),
    });
  },
}));

vi.mock('@roomote/communication/chat-messages', () => ({
  buildTaskStartingText: vi.fn(
    ({ workspaceDisplayName }: { workspaceDisplayName: string }) =>
      `Getting started on your task in ${workspaceDisplayName}`,
  ),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    update: dbUpdateMock,
    query: { mcpConnections: { findFirst: vi.fn() } },
  },
  mcpConnections: { id: 'id' },
  deploymentMcpEnablements: { mcpId: 'mcpId' },
  eq: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  consumeMcpOauthReplay: consumeMcpOauthReplayMock,
  findLinearDeploymentMcpConnection: vi.fn().mockResolvedValue({
    id: 'deployment-connection-1',
    authConfig: { linearOrganizationId: 'linear-org-1' },
  }),
  getLinearDeploymentMetadata: vi.fn().mockReturnValue({
    linearOrganizationId: 'linear-org-1',
  }),
  getValidAccessToken: vi.fn().mockResolvedValue('deployment-token'),
  LINEAR_ORG_CONNECTION_ROLE: 'linear_org',
  LINEAR_USER_CONNECTION_ROLE: 'linear_user',
}));

vi.mock('@roomote/linear', () => ({
  createLinearAgentRun: createLinearAgentRunMock,
  createLinearClient: vi.fn().mockReturnValue({
    emitThought: emitThoughtMock,
    emitResponse: vi.fn(),
    emitError: vi.fn(),
    updateSessionExternalUrls: updateSessionExternalUrlsMock,
  }),
  enrichSessionComments: vi.fn(
    (_client: unknown, agentSession: unknown) => agentSession,
  ),
  parseAgentSessionEventPayload: vi.fn().mockReturnValue({
    success: true,
    data: payload,
  }),
  resolveLinearTaskDestination: resolveLinearTaskDestinationMock,
}));

vi.mock('@/lib/server/env', () => ({
  Env: {
    TRPC_URL: 'https://api.roomote.example',
    R_APP_URL: 'https://app.roomote.example',
    R_PUBLIC_URL: 'https://public.roomote.example',
  },
}));

vi.mock('@/lib/server/get-public-app-url', () => ({
  getPublicAppUrl: vi.fn().mockReturnValue('https://public.roomote.example'),
}));

import { hydrateLinearMcpConnectionAfterOauth } from './mcp-linear';

describe('hydrateLinearMcpConnectionAfterOauth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbUpdateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });
    consumeMcpOauthReplayMock.mockResolvedValue({
      mcpId: 'linear',
      sessionId: 'session-1',
      payload,
    });
    resolveLinearTaskDestinationMock.mockResolvedValue({
      status: 'routed',
      destination: {
        workspaceSelection: { environmentId: 'env-api' },
        workspaceDisplayName: 'API',
        workspaceType: 'environment',
        kickoffMessage: 'I will inspect the retry path.',
      },
    });
    createLinearAgentRunMock.mockResolvedValue({
      status: 'ok',
      runId: 42,
      taskId: 'task-42',
    });
    emitThoughtMock.mockResolvedValue({ success: true });
    updateSessionExternalUrlsMock.mockResolvedValue({ success: true });
  });

  it('routes the first replayed session before starting its task', async () => {
    await hydrateLinearMcpConnectionAfterOauth({
      connection: {
        id: 'user-connection-1',
        connectionRole: 'linear_user',
        userId: 'roomote-user-1',
        authConfig: null,
      } as never,
      accessToken: 'user-token',
      replayToken: 'replay-token',
    });

    expect(resolveLinearTaskDestinationMock).toHaveBeenCalledWith({
      payload,
      agentSession: payload.agentSession,
      userId: 'roomote-user-1',
      linearClient: expect.any(Object),
      apiBaseUrl: 'https://api.roomote.example',
    });
    expect(createLinearAgentRunMock).toHaveBeenCalledWith({
      agentSession: payload.agentSession,
      payload,
      userId: 'roomote-user-1',
      repo: undefined,
      environmentId: 'env-api',
    });
    expect(emitThoughtMock).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'Getting started...',
      true,
    );
    expect(emitThoughtMock).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'Getting started on your task in API',
      true,
    );
    expect(updateSessionExternalUrlsMock).toHaveBeenCalledWith('session-1', [
      {
        label: 'Open task',
        url: 'https://public.roomote.example/task/task-42',
      },
    ]);
  });
});

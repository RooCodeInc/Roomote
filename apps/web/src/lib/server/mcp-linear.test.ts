const {
  consumeMcpOauthReplayMock,
  createLinearAgentRunMock,
  dbUpdateSetMock,
  dbUpdateMock,
  emitThoughtMock,
  getMcpOauthReplayMock,
  linearViewerMock,
  payload,
  resolveLinearTaskDestinationMock,
  updateSessionExternalUrlsMock,
} = vi.hoisted(() => ({
  consumeMcpOauthReplayMock: vi.fn(),
  createLinearAgentRunMock: vi.fn(),
  dbUpdateSetMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  emitThoughtMock: vi.fn(),
  getMcpOauthReplayMock: vi.fn(),
  linearViewerMock: vi.fn(),
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
    get viewer() {
      return linearViewerMock();
    }
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
    query: { mcpConnections: { findFirst: vi.fn() } },
    update: dbUpdateMock,
  },
  eq: vi.fn(),
  mcpConnections: { id: 'id' },
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
  getMcpOauthReplay: getMcpOauthReplayMock,
  getValidAccessToken: vi.fn().mockResolvedValue('deployment-token'),
  LINEAR_ORG_CONNECTION_ROLE: 'deployment',
  LINEAR_USER_CONNECTION_ROLE: 'user',
}));

vi.mock('@roomote/linear', () => ({
  createLinearAgentRun: createLinearAgentRunMock,
  createLinearClient: vi.fn().mockReturnValue({
    emitError: vi.fn(),
    emitResponse: vi.fn(),
    emitThought: emitThoughtMock,
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
    linearViewerMock.mockResolvedValue({
      id: 'linear-user-1',
      organization: Promise.resolve({ id: 'linear-org-1' }),
    });
    dbUpdateMock.mockReturnValue({
      set: dbUpdateSetMock.mockReturnValue({ where: vi.fn() }),
    });
  });

  it.each([
    {
      name: 'user',
      metadata: {
        linearUserId: 'linear-user-2',
        linearOrganizationId: 'linear-org-1',
      },
    },
    {
      name: 'organization',
      metadata: {
        linearUserId: 'linear-user-1',
        linearOrganizationId: 'linear-org-2',
      },
    },
  ])(
    'rejects a replay authorized by a different Linear $name',
    async ({ metadata }) => {
      getMcpOauthReplayMock.mockResolvedValue({
        mcpId: 'linear',
        metadata,
      });

      await expect(
        hydrateLinearMcpConnectionAfterOauth({
          connection: {
            id: 'connection-1',
            connectionRole: 'user',
            userId: 'roomote-user-1',
          } as never,
          tokens: { access_token: 'access-token' },
          replayToken: 'replay-token',
        }),
      ).rejects.toThrow(
        'The authorized Linear account does not match the requested session',
      );

      expect(dbUpdateMock).not.toHaveBeenCalled();
      expect(consumeMcpOauthReplayMock).not.toHaveBeenCalled();
    },
  );

  it('stores Linear identity metadata and OAuth tokens in one update', async () => {
    await hydrateLinearMcpConnectionAfterOauth({
      connection: {
        id: 'connection-1',
        connectionRole: 'user',
        userId: 'roomote-user-1',
        authConfig: { type: 'oauth_client', client_id: 'client-1' },
      } as never,
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        scope: 'read write',
      },
    });

    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: expect.any(Date),
        scopes: ['read', 'write'],
        authStatus: 'authenticated',
        enabled: true,
        authConfig: expect.objectContaining({
          client_id: 'client-1',
          linearOrganizationId: 'linear-org-1',
          linearUserId: 'linear-user-1',
        }),
      }),
    );
  });

  it('routes the first replayed session before starting its task', async () => {
    const replay = {
      mcpId: 'linear',
      sessionId: 'session-1',
      payload,
      metadata: {
        linearOrganizationId: 'linear-org-1',
        linearUserId: 'linear-user-1',
      },
    };
    getMcpOauthReplayMock.mockResolvedValue(replay);
    consumeMcpOauthReplayMock.mockResolvedValue(replay);
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

    await hydrateLinearMcpConnectionAfterOauth({
      connection: {
        id: 'user-connection-1',
        connectionRole: 'user',
        userId: 'roomote-user-1',
        authConfig: null,
      } as never,
      tokens: { access_token: 'user-token' },
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

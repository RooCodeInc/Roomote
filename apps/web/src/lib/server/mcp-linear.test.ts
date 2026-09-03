const {
  consumeMcpOauthReplayMock,
  dbUpdateSetMock,
  dbUpdateMock,
  emitThoughtMock,
  getMcpOauthReplayMock,
  linearViewerMock,
  payload,
  startLinearFastSessionTurnMock,
  updateSessionExternalUrlsMock,
} = vi.hoisted(() => ({
  consumeMcpOauthReplayMock: vi.fn(),
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
  startLinearFastSessionTurnMock: vi.fn(),
  updateSessionExternalUrlsMock: vi.fn(),
}));

vi.mock('@linear/sdk', () => ({
  LinearClient: class {
    get viewer() {
      return linearViewerMock();
    }
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { mcpConnections: { findFirst: vi.fn() } },
    update: dbUpdateMock,
  },
  deploymentMcpEnablements: {},
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
  startLinearFastSessionTurn: startLinearFastSessionTurnMock,
}));

vi.mock('@roomote/linear', () => ({
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

  it('stores Linear identity metadata and a replacement refresh token in one update', async () => {
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

  it('preserves the stored refresh token when refresh_token is omitted', async () => {
    await hydrateLinearMcpConnectionAfterOauth({
      connection: {
        id: 'connection-1',
        connectionRole: 'user',
        userId: 'roomote-user-1',
        refreshToken: 'stored-refresh-token',
      } as never,
      tokens: {
        access_token: 'replacement-access-token',
      },
    });

    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'replacement-access-token',
        authStatus: 'authenticated',
        enabled: true,
      }),
    );
    expect(dbUpdateSetMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'refreshToken',
    );
  });

  it('enters the replayed session into Fast under the linked user', async () => {
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
    startLinearFastSessionTurnMock.mockResolvedValue({
      status: 'queued',
      fastConversationId: 'fast-1',
    });
    emitThoughtMock.mockResolvedValue({ success: true });

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

    expect(emitThoughtMock).toHaveBeenCalledWith(
      'session-1',
      'Getting started...',
      true,
    );
    expect(startLinearFastSessionTurnMock).toHaveBeenCalledWith({
      payload,
      agentSession: payload.agentSession,
      userId: 'roomote-user-1',
      linearClient: expect.any(Object),
    });
  });
});

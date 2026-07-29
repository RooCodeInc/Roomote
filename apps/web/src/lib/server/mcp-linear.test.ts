const {
  consumeMcpOauthReplayMock,
  dbUpdateMock,
  getMcpOauthReplayMock,
  linearViewerMock,
} = vi.hoisted(() => ({
  consumeMcpOauthReplayMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  getMcpOauthReplayMock: vi.fn(),
  linearViewerMock: vi.fn(),
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
  findLinearDeploymentMcpConnection: vi.fn(),
  getLinearDeploymentMetadata: vi.fn(),
  getMcpOauthReplay: getMcpOauthReplayMock,
  getValidAccessToken: vi.fn(),
  LINEAR_ORG_CONNECTION_ROLE: 'deployment',
  LINEAR_USER_CONNECTION_ROLE: 'user',
}));

vi.mock('@roomote/linear', () => ({
  createLinearAgentRun: vi.fn(),
  createLinearClient: vi.fn(),
  enrichSessionComments: vi.fn(),
  parseAgentSessionEventPayload: vi.fn(),
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
      set: vi.fn(() => ({ where: vi.fn() })),
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
          accessToken: 'access-token',
          replayToken: 'replay-token',
        }),
      ).rejects.toThrow(
        'The authorized Linear account does not match the requested session',
      );

      expect(dbUpdateMock).not.toHaveBeenCalled();
      expect(consumeMcpOauthReplayMock).not.toHaveBeenCalled();
    },
  );
});

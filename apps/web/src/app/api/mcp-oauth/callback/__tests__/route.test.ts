import { NextRequest } from 'next/server';

const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  consumeOAuthStateMock,
  discoverOAuthEndpointsMock,
  exchangeCodeForTokensMock,
  getClientInformationMock,
  getMcpIntegrationMock,
  hydrateLinearMcpConnectionAfterOauthMock,
  isDeploymentScopedMcpIntegrationMock,
  isSelfServeMcpIntegrationMock,
  mcpConnectionsFindFirstMock,
  storeTokensMock,
  updateAuthStatusMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  consumeOAuthStateMock: vi.fn(),
  discoverOAuthEndpointsMock: vi.fn(),
  exchangeCodeForTokensMock: vi.fn(),
  getClientInformationMock: vi.fn(),
  getMcpIntegrationMock: vi.fn(),
  hydrateLinearMcpConnectionAfterOauthMock: vi.fn(),
  isDeploymentScopedMcpIntegrationMock: vi.fn(),
  isSelfServeMcpIntegrationMock: vi.fn(),
  mcpConnectionsFindFirstMock: vi.fn(),
  storeTokensMock: vi.fn(),
  updateAuthStatusMock: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  authorize: authorizeMock,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));

vi.mock('@/lib/server/mcp-linear', () => ({
  hydrateLinearMcpConnectionAfterOauth:
    hydrateLinearMcpConnectionAfterOauthMock,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      mcpConnections: {
        findFirst: mcpConnectionsFindFirstMock,
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
  mcpConnections: { id: 'mcp_connections.id' },
  deploymentMcpEnablements: { mcpId: 'deployment_mcp_enablements.mcp_id' },
  eq: vi.fn((column: string, value: string) => ({ column, value })),
}));

vi.mock('@roomote/sdk/server', () => ({
  discoverOAuthEndpoints: discoverOAuthEndpointsMock,
  exchangeCodeForTokens: exchangeCodeForTokensMock,
  consumeOAuthState: consumeOAuthStateMock,
  storeTokens: storeTokensMock,
  getClientInformation: getClientInformationMock,
  updateAuthStatus: updateAuthStatusMock,
}));

vi.mock('@roomote/types', () => ({
  getMcpIntegration: getMcpIntegrationMock,
  isDeploymentScopedMcpIntegration: isDeploymentScopedMcpIntegrationMock,
  isSelfServeMcpIntegration: isSelfServeMcpIntegrationMock,
}));

import { GET } from '../route';

const CONNECTION_ID = 'conn-linear-1';
const PUBLIC_CALLBACK = 'https://customer.example/api/mcp-oauth/callback';
const LOOPBACK_CALLBACK = 'http://localhost:13000/api/mcp-oauth/callback';

function buildRequest(query: string) {
  return new NextRequest(
    `https://customer.example/api/mcp-oauth/callback${query}`,
  );
}

describe('GET /api/mcp-oauth/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: true,
    });
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:13000',
      R_PUBLIC_URL: 'https://customer.example',
    });
    consumeOAuthStateMock.mockResolvedValue({
      connectionId: CONNECTION_ID,
      codeVerifier: 'verifier-1',
      replayToken: null,
    });
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: CONNECTION_ID,
      mcpId: 'linear',
      userId: 'user-1',
      connectionRole: 'default',
    });
    getMcpIntegrationMock.mockReturnValue({
      id: 'linear',
      name: 'Linear',
      url: 'https://mcp.linear.app/mcp',
    });
    isSelfServeMcpIntegrationMock.mockReturnValue(true);
    isDeploymentScopedMcpIntegrationMock.mockReturnValue(false);
    getClientInformationMock.mockResolvedValue({
      client_id: 'client-1',
    });
    discoverOAuthEndpointsMock.mockResolvedValue({
      authorization_endpoint: 'https://mcp.linear.app/authorize',
      token_endpoint: 'https://mcp.linear.app/token',
    });
    exchangeCodeForTokensMock.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
    storeTokensMock.mockResolvedValue(undefined);
    hydrateLinearMcpConnectionAfterOauthMock.mockResolvedValue(undefined);
  });

  it('exchanges tokens with redirect_uri from R_PUBLIC_URL and redirects there', async () => {
    const response = await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=connected',
    );
    expect(exchangeCodeForTokensMock).toHaveBeenCalledWith(
      'https://mcp.linear.app/token',
      'auth-code',
      'verifier-1',
      { client_id: 'client-1' },
      PUBLIC_CALLBACK,
    );
  });

  it('falls back to R_APP_URL for token exchange redirect_uri when R_PUBLIC_URL is unset', async () => {
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:13000',
      R_PUBLIC_URL: undefined,
    });

    const response = await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(response.headers.get('location')).toBe(
      'http://localhost:13000/settings?mcp=connected',
    );
    expect(exchangeCodeForTokensMock).toHaveBeenCalledWith(
      'https://mcp.linear.app/token',
      'auth-code',
      'verifier-1',
      { client_id: 'client-1' },
      LOOPBACK_CALLBACK,
    );
  });

  it('redirects oauth errors to the public settings host', async () => {
    const response = await GET(
      buildRequest(
        '?error=access_denied&error_description=denied&state=state-1',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error',
    );
    expect(updateAuthStatusMock).toHaveBeenCalledWith(CONNECTION_ID, 'error');
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
  });
});

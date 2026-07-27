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
  loggerErrorMock,
  loggerWarnMock,
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
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
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

vi.mock('@/lib/server/logger', () => ({
  logger: {
    error: loggerErrorMock,
    warn: loggerWarnMock,
  },
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

  it('signs in on the configured host and resumes the unconsumed callback', async () => {
    authorizeMock.mockResolvedValueOnce({ success: false });
    const request = new NextRequest(
      'https://legacy.example/api/mcp-oauth/callback?code=auth-code&state=state-1',
    );

    const response = await GET(request);

    expect(response.headers.get('location')).toBe(
      'https://customer.example/sign-in?redirect_url=%2Fapi%2Fmcp-oauth%2Fcallback%3Fcode%3Dauth-code%26state%3Dstate-1',
    );
    expect(consumeOAuthStateMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      {
        event: 'mcp_oauth_callback_auth_required',
        requestHost: 'legacy.example',
        configuredCallbackHost: 'customer.example',
        callbackHostMatchesRequest: false,
      },
      'MCP OAuth callback requires sign-in before it can continue',
    );

    const resumedResponse = await GET(
      buildRequest('?code=auth-code&state=state-1'),
    );
    expect(resumedResponse.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=connected',
    );
    expect(consumeOAuthStateMock).toHaveBeenCalledTimes(1);
    expect(storeTokensMock).toHaveBeenCalledWith(CONNECTION_ID, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
  });

  it('redirects oauth errors to the public settings host', async () => {
    const response = await GET(
      buildRequest(
        '?error=access_denied&error_description=denied&state=state-1',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error&reason=access_denied',
    );
    expect(updateAuthStatusMock).toHaveBeenCalledWith(CONNECTION_ID, 'error');
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp_oauth_provider_error',
        providerError: 'access_denied',
        hasErrorDescription: true,
      }),
      'MCP OAuth provider returned an error',
    );
  });

  it('surfaces token exchange failures with a safe reason and stage', async () => {
    exchangeCodeForTokensMock.mockRejectedValueOnce(
      new Error('provider response omitted'),
    );

    const response = await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error&reason=token_exchange_failed',
    );
    expect(updateAuthStatusMock).toHaveBeenCalledWith(CONNECTION_ID, 'error');
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp_oauth_callback_failed',
        failureStage: 'token_exchange',
        reason: 'token_exchange_failed',
        integrationId: 'linear',
        connectionId: CONNECTION_ID,
        errorName: 'Error',
      }),
      'MCP OAuth callback failed',
    );
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(
      'provider response omitted',
    );
  });

  it('distinguishes Linear workspace metadata failures after token storage', async () => {
    hydrateLinearMcpConnectionAfterOauthMock.mockRejectedValueOnce(
      new Error('viewer lookup failed'),
    );

    const response = await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(storeTokensMock).toHaveBeenCalledWith(CONNECTION_ID, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error&reason=linear_metadata_failed',
    );
    expect(updateAuthStatusMock).toHaveBeenCalledWith(CONNECTION_ID, 'error');
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp_oauth_callback_failed',
        failureStage: 'linear_metadata',
        reason: 'linear_metadata_failed',
        integrationId: 'linear',
      }),
      'MCP OAuth callback failed',
    );
  });
});

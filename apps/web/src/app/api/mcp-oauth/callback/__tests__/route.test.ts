import { NextRequest } from 'next/server';

const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  consumeOAuthStateMock,
  discoverOAuthEndpointsMock,
  exchangeCodeForTokensMock,
  getClientInformationMock,
  getMcpIntegrationMock,
  getMcpIntegrationDefaultDisabledToolsMock,
  getMcpIntegrationOauthEndpointsMock,
  hydrateLinearMcpConnectionAfterOauthMock,
  isDeploymentScopedMcpIntegrationMock,
  isSelfServeMcpIntegrationMock,
  loggerErrorMock,
  loggerWarnMock,
  mcpConnectionsFindFirstMock,
  deploymentEnablementInsertReturningMock,
  deploymentEnablementOnConflictMock,
  deploymentEnablementUpdateReturningMock,
  deploymentEnablementValuesMock,
  storeTokensMock,
  updateAuthStatusMock,
  captureEventMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  consumeOAuthStateMock: vi.fn(),
  discoverOAuthEndpointsMock: vi.fn(),
  exchangeCodeForTokensMock: vi.fn(),
  getClientInformationMock: vi.fn(),
  getMcpIntegrationMock: vi.fn(),
  getMcpIntegrationDefaultDisabledToolsMock: vi.fn(),
  getMcpIntegrationOauthEndpointsMock: vi.fn(),
  hydrateLinearMcpConnectionAfterOauthMock: vi.fn(),
  isDeploymentScopedMcpIntegrationMock: vi.fn(),
  isSelfServeMcpIntegrationMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  mcpConnectionsFindFirstMock: vi.fn(),
  deploymentEnablementInsertReturningMock: vi.fn(),
  deploymentEnablementOnConflictMock: vi.fn(),
  deploymentEnablementUpdateReturningMock: vi.fn(),
  deploymentEnablementValuesMock: vi.fn(),
  storeTokensMock: vi.fn(),
  updateAuthStatusMock: vi.fn(),
  captureEventMock: vi.fn(),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureEvent: captureEventMock,
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
  LinearReplayIdentityMismatchError: class extends Error {},
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
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: deploymentEnablementUpdateReturningMock,
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: deploymentEnablementValuesMock,
    })),
  },
  mcpConnections: { id: 'mcp_connections.id' },
  deploymentMcpEnablements: { mcpId: 'deployment_mcp_enablements.mcp_id' },
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: string, value: string | boolean) => ({ column, value })),
}));

vi.mock('@roomote/sdk/server', () => ({
  discoverOAuthEndpoints: discoverOAuthEndpointsMock,
  exchangeCodeForTokens: exchangeCodeForTokensMock,
  consumeOAuthState: consumeOAuthStateMock,
  storeTokens: storeTokensMock,
  getClientInformation: getClientInformationMock,
  updateAuthStatus: updateAuthStatusMock,
  resolveCustomMcpAuthTarget: vi.fn(async () => null),
  ensureCustomMcpServerMetadata: vi.fn(),
}));

vi.mock('@roomote/types', () => ({
  getMcpIntegration: getMcpIntegrationMock,
  getMcpIntegrationDefaultDisabledTools:
    getMcpIntegrationDefaultDisabledToolsMock,
  getMcpIntegrationOauthEndpoints: getMcpIntegrationOauthEndpointsMock,
  isDeploymentScopedMcpIntegration: isDeploymentScopedMcpIntegrationMock,
  isSelfServeMcpIntegration: isSelfServeMcpIntegrationMock,
  isCustomMcpConnectionId: (mcpId: string) => mcpId.startsWith('custom:'),
}));

import { LinearReplayIdentityMismatchError } from '@/lib/server/mcp-linear';

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
    deploymentEnablementUpdateReturningMock.mockResolvedValue([]);
    deploymentEnablementInsertReturningMock.mockResolvedValue([
      { mcpId: 'resend' },
    ]);
    deploymentEnablementOnConflictMock.mockReturnValue({
      returning: deploymentEnablementInsertReturningMock,
    });
    deploymentEnablementValuesMock.mockReturnValue({
      onConflictDoNothing: deploymentEnablementOnConflictMock,
    });
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
    getMcpIntegrationDefaultDisabledToolsMock.mockReturnValue([]);
    getMcpIntegrationOauthEndpointsMock.mockReturnValue({
      authorizationEndpoint: 'https://linear.app/oauth/authorize',
      tokenEndpoint: 'https://api.linear.app/oauth/token',
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
      'https://api.linear.app/oauth/token',
      'auth-code',
      'verifier-1',
      { client_id: 'client-1' },
      PUBLIC_CALLBACK,
    );
    expect(discoverOAuthEndpointsMock).not.toHaveBeenCalled();
    expect(captureEventMock).toHaveBeenCalledWith('integration_connected', {
      userId: 'user-1',
      properties: { integration_id: 'linear' },
    });
  });

  it('rejects a pending callback when integrations become disabled', async () => {
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:13000',
      R_PUBLIC_URL: 'https://customer.example',
      R_CURATED_INTEGRATIONS_DISABLED: true,
    });

    const response = await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error&reason=callback_failed',
    );
    // The kill switch now applies per connection kind (custom servers have
    // their own flag), so the one-time state is consumed during lookup; the
    // flow must still stop before any token exchange.
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
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
      'https://api.linear.app/oauth/token',
      'auth-code',
      'verifier-1',
      { client_id: 'client-1' },
      LOOPBACK_CALLBACK,
    );
  });

  it('resumes after sign-in without putting the authorization code in the URL', async () => {
    authorizeMock.mockResolvedValueOnce({ success: false });
    const request = buildRequest('?code=auth-code&state=state-1');

    const response = await GET(request);

    expect(response.headers.get('location')).toBe(
      'https://customer.example/sign-in?redirect_url=%2Fapi%2Fmcp-oauth%2Fcallback%3Fstate%3Dstate-1%26resume%3D1',
    );
    expect(response.headers.get('location')).not.toContain('auth-code');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('roomote-mcp-oauth-continuation-');
    expect(setCookie).toContain('auth-code');
    expect(setCookie).toContain('Path=/api/mcp-oauth/callback');
    expect(setCookie).toContain('Max-Age=600');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=lax');
    expect(consumeOAuthStateMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      {
        event: 'mcp_oauth_callback_auth_required',
        requestHost: 'customer.example',
        configuredCallbackHost: 'customer.example',
        callbackHostMatchesRequest: true,
      },
      'MCP OAuth callback requires sign-in before it can continue',
    );

    const continuationCookie = setCookie?.split(';', 1)[0];
    const resumedResponse = await GET(
      new NextRequest(
        'https://customer.example/api/mcp-oauth/callback?state=state-1&resume=1',
        { headers: { cookie: continuationCookie ?? '' } },
      ),
    );
    expect(resumedResponse.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=connected',
    );
    expect(resumedResponse.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(consumeOAuthStateMock).toHaveBeenCalledTimes(1);
    expect(exchangeCodeForTokensMock).toHaveBeenCalledWith(
      'https://api.linear.app/oauth/token',
      'auth-code',
      'verifier-1',
      { client_id: 'client-1' },
      PUBLIC_CALLBACK,
    );
    expect(hydrateLinearMcpConnectionAfterOauthMock).toHaveBeenCalledWith({
      connection: expect.objectContaining({ id: CONNECTION_ID }),
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
      replayToken: null,
      enabledByUserId: 'user-1',
    });
    expect(storeTokensMock).not.toHaveBeenCalled();
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

  it('seeds Resend tool defaults without overwriting saved choices on reconnect', async () => {
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: CONNECTION_ID,
      mcpId: 'resend',
      userId: null,
      connectionRole: 'default',
    });
    getMcpIntegrationMock.mockReturnValue({
      id: 'resend',
      name: 'Resend',
      url: 'https://mcp.resend.com/mcp',
    });
    getMcpIntegrationOauthEndpointsMock.mockReturnValue({
      authorizationEndpoint: 'https://api.resend.com/oauth/authorize',
      tokenEndpoint: 'https://api.resend.com/oauth/token',
      registrationEndpoint: 'https://api.resend.com/oauth/register',
      tokenEndpointAuthMethod: 'none',
    });
    isDeploymentScopedMcpIntegrationMock.mockReturnValue(true);
    getMcpIntegrationDefaultDisabledToolsMock.mockReturnValue([
      'send-email',
      'create-contact',
    ]);

    await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(deploymentEnablementValuesMock).toHaveBeenCalledWith({
      mcpId: 'resend',
      enabled: true,
      enabledByUserId: 'user-1',
      disabledTools: ['send-email', 'create-contact'],
    });
    expect(deploymentEnablementOnConflictMock).toHaveBeenCalledWith({
      target: 'deployment_mcp_enablements.mcp_id',
    });
    expect(captureEventMock).toHaveBeenCalledWith('integration_connected', {
      userId: 'user-1',
      properties: { integration_id: 'resend' },
    });
    expect(captureEventMock).toHaveBeenCalledWith('integration_enabled', {
      userId: 'user-1',
      properties: { integration_id: 'resend' },
    });
  });

  it('does not capture enablement when reconnecting an enabled deployment integration', async () => {
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: CONNECTION_ID,
      mcpId: 'resend',
      userId: null,
      connectionRole: 'default',
    });
    getMcpIntegrationMock.mockReturnValue({
      id: 'resend',
      name: 'Resend',
      url: 'https://mcp.resend.com/mcp',
    });
    isDeploymentScopedMcpIntegrationMock.mockReturnValue(true);
    deploymentEnablementInsertReturningMock.mockResolvedValue([]);

    await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(captureEventMock).toHaveBeenCalledWith('integration_connected', {
      userId: 'user-1',
      properties: { integration_id: 'resend' },
    });
    expect(captureEventMock).not.toHaveBeenCalledWith(
      'integration_enabled',
      expect.anything(),
    );
  });

  it('captures enablement when reconnecting a disabled deployment integration', async () => {
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: CONNECTION_ID,
      mcpId: 'resend',
      userId: null,
      connectionRole: 'default',
    });
    getMcpIntegrationMock.mockReturnValue({
      id: 'resend',
      name: 'Resend',
      url: 'https://mcp.resend.com/mcp',
    });
    isDeploymentScopedMcpIntegrationMock.mockReturnValue(true);
    deploymentEnablementUpdateReturningMock.mockResolvedValue([
      { mcpId: 'resend' },
    ]);

    await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(deploymentEnablementOnConflictMock).not.toHaveBeenCalled();
    expect(captureEventMock).toHaveBeenCalledWith('integration_enabled', {
      userId: 'user-1',
      properties: { integration_id: 'resend' },
    });
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
    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it('does not store Linear tokens when identity metadata validation fails', async () => {
    hydrateLinearMcpConnectionAfterOauthMock.mockRejectedValueOnce(
      new Error('viewer lookup failed'),
    );

    const response = await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(storeTokensMock).not.toHaveBeenCalled();
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

  it('preserves the existing connection status on replay identity mismatch', async () => {
    hydrateLinearMcpConnectionAfterOauthMock.mockRejectedValueOnce(
      new LinearReplayIdentityMismatchError(),
    );

    const response = await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error&reason=linear_metadata_failed',
    );
    expect(storeTokensMock).not.toHaveBeenCalled();
    expect(updateAuthStatusMock).not.toHaveBeenCalled();
  });
});

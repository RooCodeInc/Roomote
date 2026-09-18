import { NextRequest } from 'next/server';

const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  consumeOAuthStateMock,
  consumeMcpOauthReplayMock,
  discoverOAuthEndpointsMock,
  exchangeCodeForTokensMock,
  getClientInformationMock,
  getMcpOauthReplayMock,
  getMcpIntegrationMock,
  getMcpIntegrationDefaultDisabledToolsMock,
  getMcpIntegrationOauthEndpointsMock,
  getMcpIntegrationOauthResourceMock,
  hydrateLinearMcpConnectionAfterOauthMock,
  isDeploymentScopedMcpIntegrationMock,
  isSelfServeMcpIntegrationMock,
  loggerErrorMock,
  loggerWarnMock,
  mcpConnectionsFindFirstMock,
  sessionsFindFirstMock,
  deploymentEnablementInsertReturningMock,
  deploymentEnablementOnConflictMock,
  deploymentEnablementUpdateReturningMock,
  deploymentEnablementValuesMock,
  storeTokensMock,
  updateAuthStatusMock,
  captureEventMock,
  replyToFastSessionMock,
  resolveCustomMcpAuthTargetMock,
  ensureCustomMcpServerMetadataMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  consumeOAuthStateMock: vi.fn(),
  consumeMcpOauthReplayMock: vi.fn(),
  discoverOAuthEndpointsMock: vi.fn(),
  exchangeCodeForTokensMock: vi.fn(),
  getClientInformationMock: vi.fn(),
  getMcpOauthReplayMock: vi.fn(),
  getMcpIntegrationMock: vi.fn(),
  getMcpIntegrationDefaultDisabledToolsMock: vi.fn(),
  getMcpIntegrationOauthEndpointsMock: vi.fn(),
  getMcpIntegrationOauthResourceMock: vi.fn(),
  hydrateLinearMcpConnectionAfterOauthMock: vi.fn(),
  isDeploymentScopedMcpIntegrationMock: vi.fn(),
  isSelfServeMcpIntegrationMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  mcpConnectionsFindFirstMock: vi.fn(),
  sessionsFindFirstMock: vi.fn(),
  deploymentEnablementInsertReturningMock: vi.fn(),
  deploymentEnablementOnConflictMock: vi.fn(),
  deploymentEnablementUpdateReturningMock: vi.fn(),
  deploymentEnablementValuesMock: vi.fn(),
  storeTokensMock: vi.fn(),
  updateAuthStatusMock: vi.fn(),
  captureEventMock: vi.fn(),
  replyToFastSessionMock: vi.fn(),
  resolveCustomMcpAuthTargetMock: vi.fn(),
  ensureCustomMcpServerMetadataMock: vi.fn(),
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

vi.mock('@/trpc/commands/fast-sessions', () => ({
  replyToFastSessionCommand: replyToFastSessionMock,
}));

vi.mock('@/lib/server/integration-saved-continuation', () => ({
  buildRemoteMcpConnectedContinuation: (name: string) =>
    `<integration_saved>${name}</integration_saved>`,
  buildNativeIntegrationOauthContinuation: (name: string, outcome: string) =>
    `<integration_saved>${name}:${outcome}</integration_saved>`,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      mcpConnections: {
        findFirst: mcpConnectionsFindFirstMock,
      },
      sessions: { findFirst: sessionsFindFirstMock },
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
  sessions: {
    id: 'sessions.id',
    ownerKind: 'sessions.owner_kind',
    ownerUserId: 'sessions.owner_user_id',
  },
  deploymentMcpEnablements: { mcpId: 'deployment_mcp_enablements.mcp_id' },
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: string, value: string | boolean) => ({ column, value })),
}));

vi.mock('@roomote/sdk/server', () => ({
  discoverOAuthEndpoints: discoverOAuthEndpointsMock,
  exchangeCodeForTokens: exchangeCodeForTokensMock,
  consumeOAuthState: consumeOAuthStateMock,
  consumeMcpOauthReplay: consumeMcpOauthReplayMock,
  storeTokens: storeTokensMock,
  getClientInformation: getClientInformationMock,
  getMcpOauthReplay: getMcpOauthReplayMock,
  updateAuthStatus: updateAuthStatusMock,
  resolveCustomMcpAuthTarget: resolveCustomMcpAuthTargetMock,
  // The real rule, so these suites exercise who may authorize a custom server.
  canManageCustomMcpServer: (
    server: { ownerUserId: string | null; createdByUserId: string | null },
    actor: { userId: string; isAdmin: boolean },
  ) =>
    server.ownerUserId
      ? server.ownerUserId === actor.userId
      : actor.isAdmin || server.createdByUserId === actor.userId,
  ensureCustomMcpServerMetadata: ensureCustomMcpServerMetadataMock,
}));

vi.mock('@roomote/types', () => ({
  getMcpIntegration: getMcpIntegrationMock,
  getMcpIntegrationDefaultDisabledTools:
    getMcpIntegrationDefaultDisabledToolsMock,
  getMcpIntegrationOauthEndpoints: getMcpIntegrationOauthEndpointsMock,
  getMcpIntegrationOauthResource: getMcpIntegrationOauthResourceMock,
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
    getMcpIntegrationOauthResourceMock.mockReturnValue(undefined);
    isSelfServeMcpIntegrationMock.mockReturnValue(true);
    isDeploymentScopedMcpIntegrationMock.mockReturnValue(false);
    getClientInformationMock.mockResolvedValue({
      client_id: 'client-1',
    });
    getMcpOauthReplayMock.mockResolvedValue(null);
    discoverOAuthEndpointsMock.mockResolvedValue({
      authorization_endpoint: 'https://mcp.linear.app/authorize',
      token_endpoint: 'https://mcp.linear.app/token',
    });
    exchangeCodeForTokensMock.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
    storeTokensMock.mockResolvedValue(undefined);
    consumeMcpOauthReplayMock.mockResolvedValue(null);
    resolveCustomMcpAuthTargetMock.mockResolvedValue(null);
    ensureCustomMcpServerMetadataMock.mockResolvedValue({
      token_endpoint: 'https://auth.example.com/token',
    });
    sessionsFindFirstMock.mockResolvedValue(undefined);
    replyToFastSessionMock.mockResolvedValue({ success: true });
    hydrateLinearMcpConnectionAfterOauthMock.mockResolvedValue(undefined);
  });

  it('completes native Notion OAuth and resumes the owning Session', async () => {
    consumeOAuthStateMock.mockResolvedValue({
      connectionId: 'conn-notion-1',
      codeVerifier: 'unused-verifier',
      replayToken: 'replay-notion',
    });
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: 'conn-notion-1',
      mcpId: 'notion',
      userId: null,
      connectionRole: 'default',
    });
    getMcpIntegrationMock.mockReturnValue({
      id: 'notion',
      name: 'Notion',
      url: 'https://api.notion.com',
      oauthEndpoints: {
        authorizationEndpoint: 'https://api.notion.com/v1/oauth/authorize',
        tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
      },
      oauthTokenRequestFormat: 'json',
      oauthPkce: false,
    });
    getMcpIntegrationOauthEndpointsMock.mockReturnValue({
      authorizationEndpoint: 'https://api.notion.com/v1/oauth/authorize',
      tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
    });
    isSelfServeMcpIntegrationMock.mockReturnValue(false);
    isDeploymentScopedMcpIntegrationMock.mockReturnValue(true);
    getMcpOauthReplayMock.mockResolvedValue({
      userId: 'user-1',
      connectionId: 'conn-notion-1',
      mcpId: 'notion',
      sessionId: 'session-1',
    });
    consumeMcpOauthReplayMock.mockResolvedValue({
      userId: 'user-1',
      connectionId: 'conn-notion-1',
      mcpId: 'notion',
      sessionId: 'session-1',
    });
    sessionsFindFirstMock.mockResolvedValue({
      archivedAt: null,
      fastConversationId: 'conversation-1',
    });

    const response = await GET(buildRequest('?code=notion-code&state=state-1'));

    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=connected',
    );
    expect(exchangeCodeForTokensMock).toHaveBeenCalledWith(
      'https://api.notion.com/v1/oauth/token',
      'notion-code',
      'unused-verifier',
      { client_id: 'client-1' },
      PUBLIC_CALLBACK,
      { tokenRequestFormat: 'json', usePkce: false },
    );
    expect(storeTokensMock).toHaveBeenCalled();
    expect(replyToFastSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      {
        sessionId: 'conversation-1',
        text: '<integration_saved>Notion:connected</integration_saved>',
      },
    );
  });

  it('marks canceled native authorization as failed and resumes the Session', async () => {
    consumeOAuthStateMock.mockResolvedValue({
      connectionId: 'conn-notion-1',
      codeVerifier: 'unused-verifier',
      replayToken: 'replay-notion',
    });
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: 'conn-notion-1',
      mcpId: 'notion',
      userId: null,
      connectionRole: 'default',
    });
    getMcpIntegrationMock.mockReturnValue({ id: 'notion', name: 'Notion' });
    getMcpOauthReplayMock.mockResolvedValue({
      userId: 'user-1',
      connectionId: 'conn-notion-1',
      mcpId: 'notion',
      sessionId: 'session-1',
    });
    consumeMcpOauthReplayMock.mockResolvedValue({
      userId: 'user-1',
      connectionId: 'conn-notion-1',
      mcpId: 'notion',
      sessionId: 'session-1',
    });
    sessionsFindFirstMock.mockResolvedValue({
      archivedAt: null,
      fastConversationId: 'conversation-1',
    });

    const response = await GET(
      buildRequest('?error=access_denied&state=state-1'),
    );

    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error&reason=access_denied',
    );
    expect(updateAuthStatusMock).toHaveBeenCalledWith('conn-notion-1', 'error');
    expect(replyToFastSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      {
        sessionId: 'conversation-1',
        text: '<integration_saved>Notion:canceled</integration_saved>',
      },
    );
  });

  it('rejects a Session OAuth callback after the signed-in requester changes', async () => {
    consumeOAuthStateMock.mockResolvedValue({
      connectionId: CONNECTION_ID,
      codeVerifier: 'verifier-1',
      replayToken: 'replay-linear',
    });
    getMcpOauthReplayMock.mockResolvedValue({
      userId: 'different-user',
      connectionId: CONNECTION_ID,
      mcpId: 'linear',
      sessionId: 'session-1',
    });

    const response = await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error&reason=invalid_state',
    );
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
    expect(storeTokensMock).not.toHaveBeenCalled();
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

  it('includes the monday.com MCP resource in the token exchange', async () => {
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: CONNECTION_ID,
      mcpId: 'monday',
      userId: 'user-1',
      connectionRole: 'default',
    });
    getMcpIntegrationMock.mockReturnValue({
      id: 'monday',
      name: 'monday.com',
      url: 'https://mcp.monday.com/mcp',
    });
    getMcpIntegrationOauthEndpointsMock.mockReturnValue(undefined);
    getMcpIntegrationOauthResourceMock.mockReturnValue(
      'https://mcp.monday.com/mcp',
    );
    discoverOAuthEndpointsMock.mockResolvedValue({
      authorization_endpoint: 'https://auth.monday.com/oauth2/authorize',
      token_endpoint: 'https://auth.monday.com/oauth_ms/oauth/token',
    });

    await GET(buildRequest('?code=auth-code&state=state-1'));

    expect(exchangeCodeForTokensMock).toHaveBeenCalledWith(
      'https://auth.monday.com/oauth_ms/oauth/token',
      'auth-code',
      'verifier-1',
      { client_id: 'client-1' },
      PUBLIC_CALLBACK,
      { resource: 'https://mcp.monday.com/mcp' },
    );
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
    consumeOAuthStateMock.mockResolvedValue({
      connectionId: CONNECTION_ID,
      codeVerifier: 'verifier-1',
      replayToken: 'replay-linear',
    });
    getMcpOauthReplayMock.mockResolvedValue({
      userId: 'user-1',
      connectionId: CONNECTION_ID,
      mcpId: 'linear',
      sessionId: 'session-1',
    });
    consumeMcpOauthReplayMock.mockResolvedValue({
      userId: 'user-1',
      connectionId: CONNECTION_ID,
      mcpId: 'linear',
      sessionId: 'session-1',
    });
    sessionsFindFirstMock.mockResolvedValue({
      archivedAt: null,
      fastConversationId: 'conversation-1',
    });
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
    expect(replyToFastSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      {
        sessionId: 'conversation-1',
        text: '<integration_saved>Linear:failed</integration_saved>',
      },
    );
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

  it('continues the owning Fast Session after custom OAuth without a page visit', async () => {
    const replayToken = 'custom-replay';
    const sessionId = 'session-1';
    const encodedRedirect = Buffer.from(`/sessions/${sessionId}`).toString(
      'base64url',
    );
    consumeOAuthStateMock.mockResolvedValue({
      connectionId: CONNECTION_ID,
      codeVerifier: 'verifier-1',
      replayToken,
    });
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: CONNECTION_ID,
      mcpId: 'custom:server-1',
      userId: null,
      connectionRole: 'default',
    });
    resolveCustomMcpAuthTargetMock.mockResolvedValue({
      serverId: 'server-1',
      ownerUserId: null,
      createdByUserId: null,
      name: 'accounting',
      url: 'https://mcp.example.com/mcp',
      oauthOptions: { resource: 'https://mcp.example.com/mcp' },
    });
    getMcpIntegrationMock.mockReturnValue(undefined);
    getMcpOauthReplayMock.mockResolvedValue({
      userId: 'user-1',
      connectionId: CONNECTION_ID,
      mcpId: 'custom:server-1',
      sessionId,
    });
    consumeMcpOauthReplayMock
      .mockResolvedValueOnce({
        userId: 'user-1',
        connectionId: CONNECTION_ID,
        mcpId: 'custom:server-1',
        sessionId,
      })
      .mockResolvedValueOnce(null);
    sessionsFindFirstMock.mockResolvedValue({
      archivedAt: null,
      fastConversationId: 'fast-conversation-1',
    });

    const query = `?code=auth-code&state=state-1~${encodedRedirect}`;
    const response = await GET(buildRequest(query));
    await GET(buildRequest(query));

    expect(response.headers.get('location')).toBe(
      `https://customer.example/sessions/${sessionId}?mcp=connected`,
    );
    expect(replyToFastSessionMock).toHaveBeenCalledTimes(1);
    expect(replyToFastSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', isAdmin: true }),
      {
        sessionId: 'fast-conversation-1',
        text: '<integration_saved>accounting</integration_saved>',
      },
    );
  });
});

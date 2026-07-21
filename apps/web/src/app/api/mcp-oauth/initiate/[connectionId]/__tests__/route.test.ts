const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  discoverOAuthEndpointsMock,
  discoverOAuthProtectedResourceMetadataMock,
  generateCodeChallengeMock,
  generateCodeVerifierMock,
  generateStateMock,
  getClientInformationMock,
  getMcpIntegrationAuthorizationParametersMock,
  getMcpIntegrationMock,
  getMcpIntegrationOauthScopeModeMock,
  getMcpIntegrationOauthScopesMock,
  isDeploymentScopedMcpIntegrationMock,
  isSelfServeMcpIntegrationMock,
  mcpConnectionsFindFirstMock,
  resolveStaticOauthClientInformationMock,
  storeClientInformationMock,
  storeOAuthStateWithIdMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  discoverOAuthEndpointsMock: vi.fn(),
  discoverOAuthProtectedResourceMetadataMock: vi.fn(),
  generateCodeChallengeMock: vi.fn(),
  generateCodeVerifierMock: vi.fn(),
  generateStateMock: vi.fn(),
  getClientInformationMock: vi.fn(),
  getMcpIntegrationAuthorizationParametersMock: vi.fn(),
  getMcpIntegrationMock: vi.fn(),
  getMcpIntegrationOauthScopeModeMock: vi.fn(),
  getMcpIntegrationOauthScopesMock: vi.fn(),
  isDeploymentScopedMcpIntegrationMock: vi.fn(),
  isSelfServeMcpIntegrationMock: vi.fn(),
  mcpConnectionsFindFirstMock: vi.fn(),
  resolveStaticOauthClientInformationMock: vi.fn(),
  storeClientInformationMock: vi.fn(),
  storeOAuthStateWithIdMock: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  authorize: authorizeMock,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));

vi.mock('@/lib/server/mcp-static-oauth', () => ({
  resolveStaticOauthClientInformation: resolveStaticOauthClientInformationMock,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      mcpConnections: {
        findFirst: mcpConnectionsFindFirstMock,
      },
    },
  },
  mcpConnections: { id: 'mcp_connections.id' },
  eq: vi.fn((column: string, value: string) => ({ column, value })),
}));

vi.mock('@roomote/sdk/server', () => ({
  discoverOAuthEndpoints: discoverOAuthEndpointsMock,
  discoverOAuthProtectedResourceMetadata:
    discoverOAuthProtectedResourceMetadataMock,
  registerOAuthClient: vi.fn(),
  getPreferredTokenEndpointAuthMethod: vi.fn(),
  generateCodeVerifier: generateCodeVerifierMock,
  generateCodeChallenge: generateCodeChallengeMock,
  generateState: generateStateMock,
  storeOAuthStateWithId: storeOAuthStateWithIdMock,
  storeClientInformation: storeClientInformationMock,
  getClientInformation: getClientInformationMock,
}));

vi.mock('@roomote/types', () => ({
  getMcpIntegrationAuthorizationParameters:
    getMcpIntegrationAuthorizationParametersMock,
  getMcpIntegrationOauthScopeMode: getMcpIntegrationOauthScopeModeMock,
  getMcpIntegrationOauthScopes: getMcpIntegrationOauthScopesMock,
  getMcpIntegration: getMcpIntegrationMock,
  isDeploymentScopedMcpIntegration: isDeploymentScopedMcpIntegrationMock,
  isSelfServeMcpIntegration: isSelfServeMcpIntegrationMock,
  PRODUCT_NAME: 'Roomote',
}));

import { GET } from '../route';

const CONNECTION_ID = 'conn-linear-1';
const PUBLIC_CALLBACK = 'https://customer.example/api/mcp-oauth/callback';
const LOOPBACK_CALLBACK = 'http://localhost:13000/api/mcp-oauth/callback';

function buildRequest(path = `/api/mcp-oauth/initiate/${CONNECTION_ID}`) {
  return new Request(`https://customer.example${path}`);
}

describe('GET /api/mcp-oauth/initiate/[connectionId]', () => {
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
    discoverOAuthEndpointsMock.mockResolvedValue({
      authorization_endpoint: 'https://mcp.linear.app/authorize',
      token_endpoint: 'https://mcp.linear.app/token',
      scopes_supported: ['read', 'write'],
    });
    discoverOAuthProtectedResourceMetadataMock.mockResolvedValue(undefined);
    getClientInformationMock.mockResolvedValue({
      client_id: 'client-1',
    });
    getMcpIntegrationOauthScopesMock.mockReturnValue(undefined);
    getMcpIntegrationOauthScopeModeMock.mockReturnValue(undefined);
    getMcpIntegrationAuthorizationParametersMock.mockReturnValue([]);
    generateCodeVerifierMock.mockReturnValue('verifier-value');
    generateCodeChallengeMock.mockResolvedValue('challenge-value');
    generateStateMock.mockReturnValue('state-value');
    storeOAuthStateWithIdMock.mockResolvedValue(undefined);
    resolveStaticOauthClientInformationMock.mockReturnValue(undefined);
  });

  it('builds redirect_uri from R_PUBLIC_URL when set with loopback R_APP_URL', async () => {
    const response = await GET(buildRequest(), {
      params: Promise.resolve({ connectionId: CONNECTION_ID }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const authUrl = new URL(location!);
    expect(authUrl.origin).toBe('https://mcp.linear.app');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(PUBLIC_CALLBACK);
    expect(authUrl.searchParams.get('client_id')).toBe('client-1');
    expect(authUrl.searchParams.get('state')).toBe('state-value');
  });

  it('falls back to R_APP_URL for redirect_uri when R_PUBLIC_URL is unset', async () => {
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:13000',
      R_PUBLIC_URL: undefined,
    });

    const response = await GET(buildRequest(), {
      params: Promise.resolve({ connectionId: CONNECTION_ID }),
    });

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const authUrl = new URL(location!);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(LOOPBACK_CALLBACK);
  });

  it('avoids double slashes when R_PUBLIC_URL has a trailing slash', async () => {
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:13000',
      R_PUBLIC_URL: 'https://customer.example/',
    });

    const response = await GET(buildRequest(), {
      params: Promise.resolve({ connectionId: CONNECTION_ID }),
    });

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const authUrl = new URL(location!);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(PUBLIC_CALLBACK);
  });

  it('redirects unauthorized users to the public settings host', async () => {
    authorizeMock.mockResolvedValue({
      success: false,
    });

    const response = await GET(buildRequest(), {
      params: Promise.resolve({ connectionId: CONNECTION_ID }),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.example/settings?mcp=error&reason=unauthorized',
    );
  });
});

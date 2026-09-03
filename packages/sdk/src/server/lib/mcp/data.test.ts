const { findFirstMock, setMock, updateMock, updateWhereMock } = vi.hoisted(
  () => ({
    findFirstMock: vi.fn(),
    setMock: vi.fn(),
    updateMock: vi.fn(),
    updateWhereMock: vi.fn(),
  }),
);

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      mcpConnections: {
        findFirst: findFirstMock,
      },
    },
    update: updateMock,
  },
  mcpConnections: { id: 'mcp_connections.id' },
  eq: vi.fn((column: string, value: string) => ({ column, value })),
}));

vi.mock('@roomote/db/encryption', () => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
  decryptText: vi.fn((value: string) => value),
}));

import { getClientInformation, getValidAccessToken, storeTokens } from './data';

describe('storeTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateWhereMock.mockResolvedValue(undefined);
    setMock.mockReturnValue({ where: updateWhereMock });
    updateMock.mockReturnValue({ set: setMock });
  });

  it('clears a stale refresh token when a stored token response omits one', async () => {
    await storeTokens('conn-1', {
      access_token: 'fresh-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read write',
    });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'fresh-access-token',
        refreshToken: null,
        authStatus: 'authenticated',
        enabled: true,
        scopes: ['read', 'write'],
      }),
    );
  });

  it('stores a replacement refresh token when one is supplied', async () => {
    await storeTokens('conn-1', {
      access_token: 'fresh-access-token',
      token_type: 'Bearer',
      refresh_token: 'replacement-refresh-token',
    });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: 'replacement-refresh-token',
      }),
    );
  });
});

describe('getClientInformation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateWhereMock.mockResolvedValue(undefined);
    setMock.mockReturnValue({ where: updateWhereMock });
    updateMock.mockReturnValue({ set: setMock });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns stored oauth_client credentials when redirect URIs match', async () => {
    findFirstMock.mockResolvedValue({
      id: 'conn-1',
      mcpId: 'notion',
      authConfig: {
        type: 'oauth_client',
        client_id: 'client-1',
        registered_redirect_uri:
          'https://customer.example/api/mcp-oauth/callback',
      },
    });

    await expect(
      getClientInformation('conn-1', {
        expectedRedirectUri: 'https://customer.example/api/mcp-oauth/callback',
      }),
    ).resolves.toEqual({
      client_id: 'client-1',
      client_secret: undefined,
      client_id_issued_at: undefined,
      client_secret_expires_at: undefined,
      token_endpoint_auth_method: 'none',
    });
  });

  it('returns undefined when stored registration used a different callback', async () => {
    findFirstMock.mockResolvedValue({
      id: 'conn-1',
      mcpId: 'notion',
      authConfig: {
        type: 'oauth_client',
        client_id: 'loopback-client',
        registered_redirect_uri:
          'http://localhost:13000/api/mcp-oauth/callback',
      },
    });

    await expect(
      getClientInformation('conn-1', {
        expectedRedirectUri: 'https://customer.example/api/mcp-oauth/callback',
      }),
    ).resolves.toBeUndefined();
  });

  it('still returns the client when no expectedRedirectUri is provided', async () => {
    findFirstMock.mockResolvedValue({
      id: 'conn-1',
      mcpId: 'notion',
      authConfig: {
        type: 'oauth_client',
        client_id: 'loopback-client',
        registered_redirect_uri:
          'http://localhost:13000/api/mcp-oauth/callback',
      },
    });

    await expect(getClientInformation('conn-1')).resolves.toEqual(
      expect.objectContaining({ client_id: 'loopback-client' }),
    );
  });

  it('refreshes Linear API tokens through the Linear API token endpoint', async () => {
    findFirstMock.mockResolvedValue({
      id: 'conn-1',
      mcpId: 'linear',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(0),
      scopes: ['read', 'write'],
      authConfig: {
        type: 'oauth_client',
        client_id: 'linear-client',
        client_secret: 'enc:linear-secret',
        registered_redirect_uri:
          'https://customer.example/api/mcp-oauth/callback',
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: 'fresh-access-token',
        expires_in: 86_400,
        scope: 'read,write',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getValidAccessToken('conn-1', 'https://mcp.linear.app/mcp'),
    ).resolves.toBe('fresh-access-token');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.linear.app/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'refresh-token' }),
    );
  });
});

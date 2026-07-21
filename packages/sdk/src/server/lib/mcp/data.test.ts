const { findFirstMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      mcpConnections: {
        findFirst: findFirstMock,
      },
    },
  },
  mcpConnections: { id: 'mcp_connections.id' },
  eq: vi.fn((column: string, value: string) => ({ column, value })),
}));

vi.mock('@roomote/db/encryption', () => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
  decryptText: vi.fn((value: string) => value),
}));

import { getClientInformation } from './data';

describe('getClientInformation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

const redisState = vi.hoisted(() => new Map<string, string>());

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => {
      redisState.set(key, value);
      return 'OK';
    },
    get: async (key: string) => redisState.get(key) ?? null,
    getdel: async (key: string) => {
      const value = redisState.get(key) ?? null;
      redisState.delete(key);
      return value;
    },
  }),
}));

import {
  consumeRemoteMcpAuthorizationCode,
  createRemoteMcpAuthorizationCode,
  isAllowedOAuthRedirectUri,
  registerRemoteMcpOAuthClient,
  verifyPkceChallenge,
} from './mcp-remote-oauth';

describe('remote MCP OAuth state', () => {
  beforeEach(() => redisState.clear());

  it('accepts HTTPS and loopback redirects only', () => {
    expect(isAllowedOAuthRedirectUri('https://client.example/callback')).toBe(
      true,
    );
    expect(isAllowedOAuthRedirectUri('http://127.0.0.1:43110/callback')).toBe(
      true,
    );
    expect(isAllowedOAuthRedirectUri('http://client.example/callback')).toBe(
      false,
    );
  });

  it('stores registered client redirect URIs', async () => {
    const client = await registerRemoteMcpOAuthClient({
      clientName: 'Test client',
      redirectUris: ['https://client.example/callback'],
    });

    expect(client).toMatchObject({
      clientName: 'Test client',
      redirectUris: ['https://client.example/callback'],
    });
  });

  it('consumes authorization codes once', async () => {
    const value = {
      userId: 'user-1',
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'challenge',
      resource: 'https://api.example.com/api/mcp-routing/roomote',
      scopes: ['mcp:roomote'],
    };
    const code = await createRemoteMcpAuthorizationCode(value);

    await expect(consumeRemoteMcpAuthorizationCode(code)).resolves.toEqual(
      value,
    );
    await expect(consumeRemoteMcpAuthorizationCode(code)).resolves.toBeNull();
  });

  it('verifies S256 PKCE challenges', () => {
    expect(
      verifyPkceChallenge(
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~',
        'ImpiCd8pp4MveCNnbIS7-GXEtB0xF5HMIDoWqvGA5ig',
      ),
    ).toBe(true);
  });
});

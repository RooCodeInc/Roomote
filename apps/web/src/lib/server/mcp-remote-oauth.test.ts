const redisState = vi.hoisted(() => new Map<string, string>());

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => {
      redisState.set(key, value);
      return 'OK';
    },
    get: async (key: string) => redisState.get(key) ?? null,
    eval: async (
      script: string,
      _keyCount: number,
      key: string,
      arg: string,
    ) => {
      if (script.includes("redis.call('GET'")) {
        const value = redisState.get(key) ?? null;
        if (value === arg) redisState.delete(key);
        return value === arg ? value : null;
      }

      const count = Number(redisState.get(key) ?? '0') + 1;
      redisState.set(key, String(count));
      return count;
    },
  }),
}));

import {
  consumeRemoteMcpAuthorizationCode,
  createRemoteMcpAuthorizationCode,
  getRemoteMcpAuthorizationCode,
  isAllowedOAuthRedirectUri,
  isRemoteMcpRegistrationAllowed,
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
      resource: 'https://api.example.com/mcp',
      scopes: ['mcp:roomote'],
    };
    const code = await createRemoteMcpAuthorizationCode(value);

    await expect(getRemoteMcpAuthorizationCode(code)).resolves.toEqual(value);
    await expect(consumeRemoteMcpAuthorizationCode(code, value)).resolves.toBe(
      true,
    );
    await expect(consumeRemoteMcpAuthorizationCode(code, value)).resolves.toBe(
      false,
    );
  });

  it('does not consume a code when the expected binding differs', async () => {
    const value = {
      userId: 'user-1',
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'challenge',
      resource: 'https://api.example.com/mcp',
      scopes: ['mcp:roomote'],
    };
    const code = await createRemoteMcpAuthorizationCode(value);

    await expect(
      consumeRemoteMcpAuthorizationCode(code, {
        ...value,
        codeChallenge: 'wrong-challenge',
      }),
    ).resolves.toBe(false);
    await expect(getRemoteMcpAuthorizationCode(code)).resolves.toEqual(value);
  });

  it('bounds registrations per client and globally', async () => {
    const allowed = await Promise.all(
      Array.from({ length: 21 }, () =>
        isRemoteMcpRegistrationAllowed('203.0.113.5'),
      ),
    );

    expect(allowed.slice(0, 20).every(Boolean)).toBe(true);
    expect(allowed[20]).toBe(false);
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

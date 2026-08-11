const redisState = vi.hoisted(() => new Map<string, string>());
const redisSortedSets = vi.hoisted(
  () => new Map<string, Map<string, number>>(),
);

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => {
      redisState.set(key, value);
      return 'OK';
    },
    get: async (key: string) => redisState.get(key) ?? null,
    eval: async (script: string, keyCount: number, ...args: string[]) => {
      const keys = args.slice(0, keyCount);
      const values = args.slice(keyCount);
      const key = keys[0]!;
      if (script.includes("redis.call('ZREMRANGEBYSCORE'")) {
        const indexKey = keys[1]!;
        const [clientJson, , expiresAt, clientId, maxClients, now] = values;
        const clients = redisSortedSets.get(indexKey) ?? new Map();
        for (const [id, expiry] of clients) {
          if (expiry <= Number(now)) clients.delete(id);
        }
        if (clients.size >= Number(maxClients)) return 0;
        redisState.set(key, clientJson!);
        clients.set(clientId!, Number(expiresAt));
        redisSortedSets.set(indexKey, clients);
        return 1;
      }

      if (script.includes("redis.call('GET'")) {
        const value = redisState.get(key) ?? null;
        if (value === values[0]) redisState.delete(key);
        return value === values[0] ? value : null;
      }

      const count = Number(redisState.get(key) ?? '0') + 1;
      redisState.set(key, String(count));
      return count;
    },
  }),
}));

import {
  consumeRemoteMcpAuthorizationCode,
  consumeRemoteMcpConsentToken,
  createRemoteMcpAuthorizationCode,
  createRemoteMcpConsentToken,
  getRemoteMcpAuthorizationCode,
  isAllowedOAuthRedirectUri,
  isRemoteMcpRegistrationAllowed,
  registerRemoteMcpOAuthClient,
  verifyPkceChallenge,
} from './mcp-remote-oauth';

describe('remote MCP OAuth state', () => {
  beforeEach(() => {
    redisState.clear();
    redisSortedSets.clear();
  });

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

  it('binds consent approval to the user and authorization request', async () => {
    const binding = {
      userId: 'user-1',
      requestTarget: '/api/mcp-remote-oauth/authorize?client_id=client-1',
    };
    const token = await createRemoteMcpConsentToken(binding);

    await expect(
      consumeRemoteMcpConsentToken(token, {
        ...binding,
        userId: 'attacker',
      }),
    ).resolves.toBe(false);
    await expect(consumeRemoteMcpConsentToken(token, binding)).resolves.toBe(
      true,
    );
    await expect(consumeRemoteMcpConsentToken(token, binding)).resolves.toBe(
      false,
    );
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

  it('does not allocate client buckets after the global limit is full', async () => {
    for (let index = 0; index < 1_000; index += 1) {
      await expect(
        isRemoteMcpRegistrationAllowed(`client-${index}`),
      ).resolves.toBe(true);
    }
    const keyCountAtLimit = redisState.size;

    await expect(
      isRemoteMcpRegistrationAllowed('overflow-client'),
    ).resolves.toBe(false);
    expect(redisState.size).toBe(keyCountAtLimit);
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

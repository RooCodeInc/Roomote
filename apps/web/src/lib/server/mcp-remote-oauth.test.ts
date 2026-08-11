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
      if (script.includes("redis.call('ZCARD', KEYS[2])")) {
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

      if (script.includes('local previousSessionId =')) {
        const [sessionPrefix, refreshPrefix, sessionJson, marker, sessionId] =
          values;
        const previousSessionId = redisState.get(keys[2]!);
        if (previousSessionId) {
          const previousSessionKey = `${sessionPrefix}${previousSessionId}`;
          const previous = redisState.get(previousSessionKey);
          if (previous) {
            const decoded = JSON.parse(previous) as {
              currentTokenHash: string;
            };
            redisState.delete(`${refreshPrefix}${decoded.currentTokenHash}`);
          }
          redisState.delete(previousSessionKey);
        }
        redisState.set(key, sessionJson!);
        redisState.set(keys[1]!, marker!);
        redisState.set(keys[2]!, sessionId!);
        return 1;
      }

      if (script.includes("return {'reuse'}")) {
        const [rotatedMarker, activeMarker, expected, next, refreshPrefix] =
          values;
        const marker = redisState.get(key);
        if (marker === rotatedMarker) {
          const session = redisState.get(keys[2]!);
          if (session) {
            const decoded = JSON.parse(session) as {
              currentTokenHash: string;
            };
            redisState.delete(`${refreshPrefix}${decoded.currentTokenHash}`);
          }
          redisState.delete(keys[2]!);
          return ['reuse'];
        }
        if (marker !== activeMarker || redisState.get(keys[2]!) !== expected) {
          return ['invalid'];
        }
        redisState.set(key, rotatedMarker!);
        redisState.set(keys[1]!, activeMarker!);
        redisState.set(keys[2]!, next!);
        return ['ok'];
      }

      if (script.includes('decoded.clientId')) {
        const [clientId, refreshPrefix, activeMarker, tokenHash] = values;
        if (redisState.get(key) !== activeMarker) return 0;
        const session = redisState.get(keys[1]!);
        if (!session) return 0;
        const decoded = JSON.parse(session) as {
          clientId: string;
          currentTokenHash: string;
        };
        if (
          decoded.clientId !== clientId ||
          decoded.currentTokenHash !== tokenHash
        ) {
          return 0;
        }
        redisState.delete(`${refreshPrefix}${decoded.currentTokenHash}`);
        redisState.delete(key);
        redisState.delete(keys[1]!);
        return 1;
      }

      if (script.includes('local client = tonumber')) {
        const globalKey = keys[1]!;
        const [, clientLimit, globalLimit] = values;
        const clientCount = Number(redisState.get(key) ?? '0');
        const globalCount = Number(redisState.get(globalKey) ?? '0');
        if (
          clientCount >= Number(clientLimit) ||
          globalCount >= Number(globalLimit)
        ) {
          return 0;
        }
        redisState.set(key, String(clientCount + 1));
        redisState.set(globalKey, String(globalCount + 1));
        return 1;
      }

      if (script.includes("redis.call('ZREM'")) {
        const indexKey = keys[1]!;
        const globalIndexKey = keys[2]!;
        const userIndexKey = keys[3]!;
        const clientId = values[1]!;
        const now = Number(values[2]);
        const expiresAt = Number(values[3]);
        const globalLimit = Number(values[4]);
        const userLimit = Number(values[5]);
        const globalClients = redisSortedSets.get(globalIndexKey) ?? new Map();
        const userClients = redisSortedSets.get(userIndexKey) ?? new Map();
        for (const [id, expiry] of globalClients) {
          if (expiry <= now) globalClients.delete(id);
        }
        for (const [id, expiry] of userClients) {
          if (expiry <= now) userClients.delete(id);
        }
        if (!globalClients.has(clientId) && globalClients.size >= globalLimit) {
          return 0;
        }
        if (!userClients.has(clientId) && userClients.size >= userLimit) {
          return 0;
        }
        if (!redisState.has(key)) return 0;
        redisSortedSets.get(indexKey)?.delete(clientId);
        globalClients.set(clientId, expiresAt);
        redisSortedSets.set(globalIndexKey, globalClients);
        userClients.set(clientId, expiresAt);
        redisSortedSets.set(userIndexKey, userClients);
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
  createRemoteMcpRefreshSession,
  getRemoteMcpAuthorizationCode,
  getRemoteMcpRefreshSession,
  isAllowedOAuthRedirectUri,
  isRemoteMcpRegistrationAllowed,
  promoteRemoteMcpOAuthClient,
  registerRemoteMcpOAuthClient,
  revokeRemoteMcpRefreshSession,
  rotateRemoteMcpRefreshToken,
  verifyPkceChallenge,
} from './mcp-remote-oauth';

describe('remote MCP OAuth state', () => {
  beforeEach(() => {
    redisState.clear();
    redisSortedSets.clear();
  });

  it('accepts HTTPS, loopback, and the Cursor desktop callback', () => {
    expect(isAllowedOAuthRedirectUri('https://client.example/callback')).toBe(
      true,
    );
    expect(isAllowedOAuthRedirectUri('http://127.0.0.1:43110/callback')).toBe(
      true,
    );
    expect(
      isAllowedOAuthRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'),
    ).toBe(true);
    expect(isAllowedOAuthRedirectUri('http://client.example/callback')).toBe(
      false,
    );
    expect(isAllowedOAuthRedirectUri('cursor://other-client/callback')).toBe(
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
      grantTypes: ['authorization_code'],
    });
    await expect(
      promoteRemoteMcpOAuthClient(client.clientId, 'user-1'),
    ).resolves.toBe(true);
    expect(
      [...redisSortedSets.entries()].find(([key]) =>
        key.includes('registered-clients'),
      )?.[1].size,
    ).toBe(0);
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

  it('rotates refresh tokens and revokes the session on reuse', async () => {
    const refreshToken = await createRemoteMcpRefreshSession({
      userId: 'user-1',
      clientId: 'client-1',
      resource: 'https://roomote.example/mcp',
      scopes: ['mcp:roomote'],
    });
    const session = await getRemoteMcpRefreshSession(refreshToken);
    expect(session).toMatchObject({ userId: 'user-1', clientId: 'client-1' });

    const rotation = await rotateRemoteMcpRefreshToken(refreshToken, session!);
    expect(rotation.status).toBe('ok');
    if (rotation.status !== 'ok') throw new Error('expected refresh rotation');
    await expect(
      getRemoteMcpRefreshSession(rotation.refreshToken),
    ).resolves.toMatchObject({ userId: 'user-1' });

    await expect(
      rotateRemoteMcpRefreshToken(refreshToken, session!),
    ).resolves.toEqual({ status: 'reuse' });
    await expect(
      getRemoteMcpRefreshSession(rotation.refreshToken),
    ).resolves.toBeNull();
  });

  it('isolates a replacement authorization from old-family replay', async () => {
    const previousToken = await createRemoteMcpRefreshSession({
      userId: 'user-1',
      clientId: 'client-1',
      resource: 'https://roomote.example/mcp',
      scopes: ['mcp:roomote'],
    });
    const previousSession = await getRemoteMcpRefreshSession(previousToken);
    const previousRotation = await rotateRemoteMcpRefreshToken(
      previousToken,
      previousSession!,
    );
    expect(previousRotation.status).toBe('ok');

    const replacementToken = await createRemoteMcpRefreshSession({
      userId: 'user-1',
      clientId: 'client-1',
      resource: 'https://roomote.example/mcp',
      scopes: ['mcp:roomote'],
    });
    const replacementSession =
      await getRemoteMcpRefreshSession(replacementToken);
    expect(replacementSession?.sessionId).not.toBe(previousSession?.sessionId);
    if (previousRotation.status !== 'ok') {
      throw new Error('expected previous refresh rotation');
    }
    await expect(
      getRemoteMcpRefreshSession(previousRotation.refreshToken),
    ).resolves.toBeNull();

    await expect(
      rotateRemoteMcpRefreshToken(previousToken, previousSession!),
    ).resolves.toEqual({ status: 'reuse' });
    await expect(getRemoteMcpRefreshSession(replacementToken)).resolves.toEqual(
      replacementSession,
    );
  });

  it('revokes a refresh session by client ID', async () => {
    const refreshToken = await createRemoteMcpRefreshSession({
      userId: 'user-1',
      clientId: 'client-1',
      resource: 'https://roomote.example/mcp',
      scopes: ['mcp:roomote'],
    });

    await revokeRemoteMcpRefreshSession(refreshToken, 'client-1');

    await expect(getRemoteMcpRefreshSession(refreshToken)).resolves.toBeNull();
  });

  it('does not revoke a refresh session with a forged token secret', async () => {
    const refreshToken = await createRemoteMcpRefreshSession({
      userId: 'user-1',
      clientId: 'client-1',
      resource: 'https://roomote.example/mcp',
      scopes: ['mcp:roomote'],
    });
    const [sessionId] = refreshToken.split('.');

    await revokeRemoteMcpRefreshSession(
      `${sessionId}.${'a'.repeat(43)}`,
      'client-1',
    );

    await expect(
      getRemoteMcpRefreshSession(refreshToken),
    ).resolves.toMatchObject({ userId: 'user-1', clientId: 'client-1' });
  });

  it('bounds registrations per client and globally', async () => {
    const allowed = [];
    for (let index = 0; index < 21; index += 1) {
      allowed.push(await isRemoteMcpRegistrationAllowed('same-client'));
    }

    expect(allowed.slice(0, 20).every(Boolean)).toBe(true);
    expect(allowed[20]).toBe(false);
    expect(
      [...redisState.entries()].find(([key]) => key.includes(':global:'))?.[1],
    ).toBe('20');
  });

  it('does not allocate client buckets after the global limit is full', async () => {
    for (let index = 0; index < 100; index += 1) {
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

  it('caps promoted clients per signed-in user', async () => {
    for (let index = 0; index < 50; index += 1) {
      const client = await registerRemoteMcpOAuthClient({
        redirectUris: [`https://client-${index}.example/callback`],
      });
      await expect(
        promoteRemoteMcpOAuthClient(client.clientId, 'user-1'),
      ).resolves.toBe(true);
    }
    const overflowClient = await registerRemoteMcpOAuthClient({
      redirectUris: ['https://overflow.example/callback'],
    });

    await expect(
      promoteRemoteMcpOAuthClient(overflowClient.clientId, 'user-1'),
    ).resolves.toBe(false);
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

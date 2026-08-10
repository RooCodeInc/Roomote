import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deleteWhereMock,
  deleteMock,
  executeMock,
  insertMock,
  writeMock,
  decryptMock,
} = vi.hoisted(() => {
  const deleteWhereMock = vi.fn(async () => undefined);
  const writeMock = vi.fn(async () => undefined);
  return {
    deleteWhereMock,
    deleteMock: vi.fn(() => ({ where: deleteWhereMock })),
    executeMock: vi.fn(),
    insertMock: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: writeMock,
      })),
    })),
    writeMock,
    decryptMock: vi.fn(),
  };
});

vi.mock('@roomote/db/server', () => ({
  db: { delete: deleteMock, execute: executeMock, insert: insertMock },
  deploymentSecrets: { name: 'deployment_secrets.name' },
  eq: (left: unknown, right: unknown) => ({ left, right }),
  sql: vi.fn(),
}));

vi.mock('@roomote/db/encryption', () => ({
  decryptSecrets: decryptMock,
  encryptJSON: vi.fn(() => 'encrypted-connection'),
}));

import {
  BITBUCKET_OAUTH_CALLBACK_PATH,
  buildBitbucketOAuthRedirectUri,
  createBitbucketOAuthAuthorizationUrl,
  deleteBitbucketOAuthConnection,
  exchangeBitbucketOAuthCode,
  getBitbucketOAuthScopes,
  isBitbucketOAuthAccessToken,
  resolveBitbucketOAuthAccessToken,
  resolveBitbucketOAuthAccessTokenWithMetadata,
} from '../oauth';

describe('Bitbucket deployment OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the shared Better Auth callback path', () => {
    expect(buildBitbucketOAuthRedirectUri('https://roomote.test/')).toBe(
      `https://roomote.test${BITBUCKET_OAUTH_CALLBACK_PATH}`,
    );
  });

  it('builds the Bitbucket authorization URL with Roomote scopes', () => {
    const result = createBitbucketOAuthAuthorizationUrl({
      clientId: 'consumer-id',
      redirectUri: buildBitbucketOAuthRedirectUri('https://roomote.test'),
      state: 'csrf-state',
    });
    const url = new URL(result.url);

    expect(url.origin).toBe('https://bitbucket.org');
    expect(url.pathname).toBe('/site/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('consumer-id');
    expect(url.searchParams.get('state')).toBe('csrf-state');
    expect(url.searchParams.get('scope')).toBe(
      getBitbucketOAuthScopes().join(' '),
    );
  });

  it('deletes the encrypted connection and clears cached tokens', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'bitbucket-access-token',
          refresh_token: 'bitbucket-refresh-token',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: '42', username: 'roomote' }),
      });
    await exchangeBitbucketOAuthCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'code',
      redirectUri: 'https://roomote.example/callback',
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(isBitbucketOAuthAccessToken('bitbucket-access-token')).toBe(true);

    await deleteBitbucketOAuthConnection();

    expect(deleteWhereMock).toHaveBeenCalledOnce();
    expect(isBitbucketOAuthAccessToken('bitbucket-access-token')).toBe(false);
  });

  it('bounds the OAuth code exchange request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    await expect(
      exchangeBitbucketOAuthCode({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'code',
        redirectUri: 'https://roomote.example/callback',
        fetchImpl,
        requestTimeoutMs: 10,
      }),
    ).rejects.toThrow();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('waits for an in-flight refresh and prevents it from recreating the connection', async () => {
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(0).toISOString(),
      accountId: '42',
      username: 'roomote',
      scopes: ['account'],
      status: 'active',
    });
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => (resolveResponse = resolve)),
    );

    const refresh = resolveBitbucketOAuthAccessToken({
      fetchImpl: fetchImpl as typeof fetch,
      forceRefresh: true,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const deletion = deleteBitbucketOAuthConnection();
    expect(deleteWhereMock).not.toHaveBeenCalled();

    resolveResponse(
      Response.json({
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
      }),
    );

    await expect(refresh).resolves.toBeNull();
    await deletion;
    expect(writeMock).not.toHaveBeenCalled();
    expect(deleteWhereMock).toHaveBeenCalledOnce();
  });

  it('returns the matching OAuth expiry with a valid access token', async () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'active-access-token',
      refreshToken: 'refresh-token',
      expiresAt,
      accountId: '42',
      username: 'roomote',
      scopes: ['account'],
      status: 'active',
    });

    await expect(
      resolveBitbucketOAuthAccessTokenWithMetadata(),
    ).resolves.toEqual({
      accessToken: 'active-access-token',
      expiresAt: new Date(expiresAt),
    });
  });

  it('keeps the connection active when refresh fails transiently', async () => {
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(0).toISOString(),
      accountId: '42',
      username: 'roomote',
      scopes: ['account'],
      status: 'active',
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: 'temporarily_unavailable' },
          { status: 503, statusText: 'Service Unavailable' },
        ),
      );

    await expect(
      resolveBitbucketOAuthAccessToken({ fetchImpl, forceRefresh: true }),
    ).rejects.toThrow(
      'Bitbucket OAuth refresh failed: 503 Service Unavailable',
    );
    expect(writeMock).not.toHaveBeenCalled();
  });

  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])(
    'requires reauthorization for definitive %s failures',
    async (oauthError) => {
      executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
      decryptMock.mockResolvedValue({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accessToken: 'expired-access-token',
        refreshToken: 'revoked-refresh-token',
        expiresAt: new Date(0).toISOString(),
        accountId: '42',
        username: 'roomote',
        scopes: ['account'],
        status: 'active',
      });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: oauthError },
            { status: 400, statusText: 'Bad Request' },
          ),
        );

      await expect(
        resolveBitbucketOAuthAccessToken({ fetchImpl, forceRefresh: true }),
      ).rejects.toThrow('Bitbucket OAuth refresh failed: 400 Bad Request');
      expect(writeMock).toHaveBeenCalledOnce();
    },
  );

  it('uses a peer-rotated token when the old refresh grant is rejected', async () => {
    const peerExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock
      .mockResolvedValueOnce({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accessToken: 'expired-access-token',
        refreshToken: 'stale-refresh-token',
        expiresAt: new Date(0).toISOString(),
        accountId: '42',
        username: 'roomote',
        scopes: ['account'],
        status: 'active',
      })
      .mockResolvedValueOnce({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accessToken: 'peer-access-token',
        refreshToken: 'peer-refresh-token',
        expiresAt: peerExpiresAt,
        accountId: '42',
        username: 'roomote',
        scopes: ['account'],
        status: 'active',
      });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: 'invalid_grant' },
          { status: 400, statusText: 'Bad Request' },
        ),
      );

    await expect(
      resolveBitbucketOAuthAccessToken({ fetchImpl, forceRefresh: true }),
    ).resolves.toBe('peer-access-token');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('keeps the connection active when the refresh request times out', async () => {
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(0).toISOString(),
      accountId: '42',
      username: 'roomote',
      scopes: ['account'],
      status: 'active',
    });
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    await expect(
      resolveBitbucketOAuthAccessToken({
        fetchImpl,
        forceRefresh: true,
        requestTimeoutMs: 10,
      }),
    ).rejects.toThrow();
    expect(writeMock).not.toHaveBeenCalled();
  });
});

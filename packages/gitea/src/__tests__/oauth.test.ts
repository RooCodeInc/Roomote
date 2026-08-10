import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deleteWhereMock,
  deleteMock,
  findFirstMock,
  insertMock,
  writeMock,
  decryptMock,
} = vi.hoisted(() => {
  const deleteWhereMock = vi.fn(async () => undefined);
  const writeMock = vi.fn(async () => undefined);
  return {
    deleteWhereMock,
    deleteMock: vi.fn(() => ({ where: deleteWhereMock })),
    findFirstMock: vi.fn(),
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
  db: {
    delete: deleteMock,
    insert: insertMock,
    query: { deploymentSecrets: { findFirst: findFirstMock } },
  },
  deploymentSecrets: { name: 'deployment_secrets.name' },
  eq: (left: unknown, right: unknown) => ({ left, right }),
}));

vi.mock('@roomote/db/encryption', () => ({
  decryptSecrets: decryptMock,
  encryptJSON: vi.fn(() => 'encrypted-connection'),
}));

import {
  buildGiteaOAuthRedirectUri,
  createGiteaOAuthAuthorizationUrl,
  deleteGiteaOAuthConnection,
  exchangeGiteaOAuthCode,
  getGiteaOAuthScopes,
  isGiteaOAuthAccessToken,
  resolveGiteaOAuthAccessToken,
} from '../oauth';

describe('Gitea deployment OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('centralizes the granular deployment scopes', () => {
    expect(getGiteaOAuthScopes()).toEqual([
      'read:user',
      'read:repository',
      'write:repository',
      'write:issue',
      'read:organization',
    ]);
  });

  it('builds a self-managed callback and deployment-bound authorization state', () => {
    const redirectUri = buildGiteaOAuthRedirectUri('https://roomote.example/');
    const result = createGiteaOAuthAuthorizationUrl({
      baseUrl: 'https://git.example/gitea',
      clientId: 'client-id',
      redirectUri,
      state: 'deployment-state',
    });
    const url = new URL(result.url);

    expect(redirectUri).toBe(
      'https://roomote.example/api/source-control/gitea/oauth/callback',
    );
    expect(url.origin).toBe('https://git.example');
    expect(url.pathname).toBe('/gitea/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toBe('deployment-state');
    expect(url.searchParams.get('scope')).toBe(getGiteaOAuthScopes().join(' '));
  });

  it('preserves a self-managed Gitea base path in the authorization URL', () => {
    const result = createGiteaOAuthAuthorizationUrl({
      baseUrl: 'https://git.example/gitea',
      clientId: 'client-id',
      redirectUri: 'https://roomote.example/callback',
      state: 'state',
    });

    expect(new URL(result.url).toString()).toContain(
      'https://git.example/gitea/login/oauth/authorize?',
    );
  });

  it('deletes the encrypted connection and clears cached tokens', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'gitea-access-token',
          refresh_token: 'gitea-refresh-token',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 42, login: 'roomote' }),
      });
    await exchangeGiteaOAuthCode({
      baseUrl: 'https://gitea.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'code',
      redirectUri: 'https://roomote.example/callback',
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(isGiteaOAuthAccessToken('gitea-access-token')).toBe(true);

    await deleteGiteaOAuthConnection();

    expect(deleteWhereMock).toHaveBeenCalledOnce();
    expect(isGiteaOAuthAccessToken('gitea-access-token')).toBe(false);
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
      exchangeGiteaOAuthCode({
        baseUrl: 'https://gitea.example',
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
    findFirstMock.mockResolvedValue({ value: 'encrypted-connection' });
    decryptMock.mockResolvedValue({
      baseUrl: 'https://gitea.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(0).toISOString(),
      scopes: ['read:user'],
      status: 'active',
    });
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => (resolveResponse = resolve)),
    );

    const refresh = resolveGiteaOAuthAccessToken({
      fetchImpl: fetchImpl as typeof fetch,
      forceRefresh: true,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const deletion = deleteGiteaOAuthConnection();
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

  it('keeps the connection active when refresh fails transiently', async () => {
    findFirstMock.mockResolvedValue({ value: 'encrypted-connection' });
    decryptMock.mockResolvedValue({
      baseUrl: 'https://gitea.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(0).toISOString(),
      scopes: ['read:user'],
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

    await expect(resolveGiteaOAuthAccessToken({ fetchImpl })).rejects.toThrow(
      'Gitea OAuth refresh failed: 503 Service Unavailable',
    );
    expect(writeMock).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitea.example/login/oauth/access_token',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('keeps the connection active when the refresh request times out', async () => {
    findFirstMock.mockResolvedValue({ value: 'encrypted-connection' });
    decryptMock.mockResolvedValue({
      baseUrl: 'https://gitea.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(0).toISOString(),
      scopes: ['read:user'],
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
      resolveGiteaOAuthAccessToken({
        fetchImpl,
        requestTimeoutMs: 10,
      }),
    ).rejects.toThrow();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])(
    'requires reauthorization for definitive %s failures',
    async (oauthError) => {
      findFirstMock.mockResolvedValue({ value: 'encrypted-connection' });
      decryptMock.mockResolvedValue({
        baseUrl: 'https://gitea.example',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accountId: '42',
        username: 'roomote',
        accessToken: 'expired-access-token',
        refreshToken: 'refresh-token',
        expiresAt: new Date(0).toISOString(),
        scopes: ['read:user'],
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

      await expect(resolveGiteaOAuthAccessToken({ fetchImpl })).rejects.toThrow(
        'Gitea OAuth authorization has expired and must be renewed.',
      );
      expect(writeMock).toHaveBeenCalledOnce();
    },
  );

  it('uses a peer-rotated token when the old refresh grant is rejected', async () => {
    findFirstMock.mockResolvedValue({ value: 'encrypted-connection' });
    decryptMock
      .mockResolvedValueOnce({
        baseUrl: 'https://gitea.example',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accountId: '42',
        username: 'roomote',
        accessToken: 'expired-access-token',
        refreshToken: 'stale-refresh-token',
        expiresAt: new Date(0).toISOString(),
        scopes: ['read:user'],
        status: 'active',
      })
      .mockResolvedValueOnce({
        baseUrl: 'https://gitea.example',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accountId: '42',
        username: 'roomote',
        accessToken: 'peer-access-token',
        refreshToken: 'peer-refresh-token',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        scopes: ['read:user'],
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
      resolveGiteaOAuthAccessToken({ fetchImpl, forceRefresh: true }),
    ).resolves.toBe('peer-access-token');
    expect(writeMock).not.toHaveBeenCalled();
  });
});

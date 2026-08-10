import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deleteWhereMock,
  deleteMock,
  executeMock,
  insertMock,
  writeMock,
  decryptMock,
  encryptMock,
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
    encryptMock: vi.fn(() => 'encrypted-connection'),
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
  encryptJSON: encryptMock,
}));

import {
  buildGitLabOAuthRedirectUri,
  createGitLabOAuthAuthorizationUrl,
  deleteGitLabOAuthConnection,
  exchangeGitLabOAuthCode,
  isGitLabOAuthAccessToken,
  resolveGitLabOAuthAccessToken,
} from '../oauth';

describe('GitLab deployment OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves a self-managed GitLab base path in the authorization URL', () => {
    const result = createGitLabOAuthAuthorizationUrl({
      baseUrl: 'https://git.example/gitlab',
      clientId: 'client-id',
      redirectUri: 'https://roomote.example/callback',
      state: 'state',
    });

    expect(new URL(result.url).toString()).toContain(
      'https://git.example/gitlab/oauth/authorize?',
    );
  });

  it('builds the callback redirect URI from the app public URL', () => {
    expect(buildGitLabOAuthRedirectUri('https://customer.roomote.ai')).toBe(
      'https://customer.roomote.ai/api/source-control/gitlab/oauth/callback',
    );
    expect(buildGitLabOAuthRedirectUri('https://customer.roomote.ai/')).toBe(
      'https://customer.roomote.ai/api/source-control/gitlab/oauth/callback',
    );
  });

  it('deletes the encrypted connection and clears cached tokens', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'gitlab-access-token',
          refresh_token: 'gitlab-refresh-token',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 42, username: 'roomote' }),
      });
    await exchangeGitLabOAuthCode({
      baseUrl: 'https://gitlab.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'code',
      redirectUri: 'https://roomote.example/callback',
      fetchImpl,
    });
    expect(isGitLabOAuthAccessToken('gitlab-access-token')).toBe(true);

    await deleteGitLabOAuthConnection();

    expect(deleteWhereMock).toHaveBeenCalledOnce();
    expect(isGitLabOAuthAccessToken('gitlab-access-token')).toBe(false);
  });

  it('does not classify unrelated tokens as OAuth while a session is active', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'session-access-token',
          refresh_token: 'session-refresh-token',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 42, username: 'roomote' }),
      });
    await exchangeGitLabOAuthCode({
      baseUrl: 'https://gitlab.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'code',
      redirectUri: 'https://roomote.example/callback',
      fetchImpl,
    });

    expect(isGitLabOAuthAccessToken('session-access-token')).toBe(true);
    // Self-managed instances can customise the PAT prefix, and deploy/CI job
    // tokens carry none, so an unrecognised token must not become a Bearer.
    expect(isGitLabOAuthAccessToken('acme-pat-abc123')).toBe(false);
    expect(isGitLabOAuthAccessToken('glpat-personal-token')).toBe(false);

    await deleteGitLabOAuthConnection();
  });

  it('scales the proactive refresh window to a short instance token lifetime', async () => {
    // Self-managed instances can configure a much shorter OAuth TTL than
    // GitLab's ~2h default. A fixed 10m skew would then exceed the whole
    // lifetime and refresh on every single resolve.
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      baseUrl: 'https://gitlab.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'short-lived-access-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 300,
      // 4 of its 5 minutes left: well inside a fixed 10m skew, but nowhere
      // near the quarter-life mark for a 5m token.
      expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
      scopes: ['api'],
      status: 'active',
    });
    const fetchImpl = vi.fn();

    await expect(
      resolveGitLabOAuthAccessToken({ fetchImpl: fetchImpl as typeof fetch }),
    ).resolves.toBe('short-lived-access-token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still refreshes a short-lived token once it passes its quarter-life mark', async () => {
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      baseUrl: 'https://gitlab.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'short-lived-access-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 300,
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      scopes: ['api'],
      status: 'active',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'short-lived-refreshed-token',
        refresh_token: 'new-refresh-token',
        expires_in: 300,
      }),
    );

    await expect(
      resolveGitLabOAuthAccessToken({ fetchImpl: fetchImpl as typeof fetch }),
    ).resolves.toBe('short-lived-refreshed-token');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('marks reauthorization required when a failed refresh was not preempted', async () => {
    // The connection re-read after the failure is unchanged, so no peer
    // rotated the tokens and the refusal is a genuine invalid_grant.
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      baseUrl: 'https://gitlab.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'revoked-access-token',
      refreshToken: 'revoked-refresh-token',
      // Inside the proactive skew but not yet expired.
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      scopes: ['api'],
      status: 'active',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        statusText: 'Bad Request',
      }),
    );

    await expect(
      resolveGitLabOAuthAccessToken({ fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/must be renewed/);
    expect(encryptMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reauthorization_required' }),
    );
  });

  it('ignores a peer rotation that is already inside the refresh window', async () => {
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock
      .mockResolvedValueOnce({
        baseUrl: 'https://gitlab.example',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accountId: '42',
        username: 'roomote',
        accessToken: 'stale-access-token',
        refreshToken: 'stale-refresh-token',
        expiresAt: new Date(0).toISOString(),
        scopes: ['api'],
        status: 'active',
      })
      .mockResolvedValueOnce({
        baseUrl: 'https://gitlab.example',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accountId: '42',
        username: 'roomote',
        accessToken: 'peer-refreshed-access-token',
        refreshToken: 'peer-refreshed-refresh-token',
        // Changed, but dies before the worker could refresh again.
        expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
        scopes: ['api'],
        status: 'active',
      });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        statusText: 'Bad Request',
      }),
    );

    await expect(
      resolveGitLabOAuthAccessToken({
        fetchImpl: fetchImpl as typeof fetch,
        forceRefresh: true,
      }),
    ).rejects.toThrow(/must be renewed/);
  });

  it('uses a still-valid token when concurrent refresh fails', async () => {
    const stillValidUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock
      .mockResolvedValueOnce({
        baseUrl: 'https://gitlab.example',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accountId: '42',
        username: 'roomote',
        accessToken: 'stale-access-token',
        refreshToken: 'stale-refresh-token',
        expiresAt: new Date(0).toISOString(),
        scopes: ['api'],
        status: 'active',
      })
      .mockResolvedValueOnce({
        baseUrl: 'https://gitlab.example',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accountId: '42',
        username: 'roomote',
        accessToken: 'peer-refreshed-access-token',
        refreshToken: 'peer-refreshed-refresh-token',
        expiresAt: stillValidUntil,
        scopes: ['api'],
        status: 'active',
      });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        statusText: 'Bad Request',
      }),
    );

    await expect(
      resolveGitLabOAuthAccessToken({
        fetchImpl: fetchImpl as typeof fetch,
        forceRefresh: true,
      }),
    ).resolves.toBe('peer-refreshed-access-token');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('proactively refreshes OAuth access tokens inside the 10-minute skew window', async () => {
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      baseUrl: 'https://gitlab.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'near-expiry-access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      scopes: ['api'],
      status: 'active',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'proactively-refreshed-token',
        refresh_token: 'new-refresh-token',
        expires_in: 7200,
      }),
    );

    const token = await resolveGitLabOAuthAccessToken({
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(token).toBe('proactively-refreshed-token');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(isGitLabOAuthAccessToken('proactively-refreshed-token')).toBe(true);
  });

  it('keeps the just-rotated token classified as OAuth for in-flight callers', async () => {
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    const connection = {
      baseUrl: 'https://gitlab.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'rotating-access-token',
      refreshToken: 'refresh-token',
      scopes: ['api'],
      status: 'active',
    };
    decryptMock
      .mockResolvedValueOnce({
        ...connection,
        expiresAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        ...connection,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

    // A caller resolves and holds this token...
    await expect(resolveGitLabOAuthAccessToken()).resolves.toBe(
      'rotating-access-token',
    );
    // ...while a later resolve rotates it out from under them.
    await expect(
      resolveGitLabOAuthAccessToken({
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({
            access_token: 'rotated-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 7200,
          }),
        ) as typeof fetch,
      }),
    ).resolves.toBe('rotated-access-token');

    expect(isGitLabOAuthAccessToken('rotated-access-token')).toBe(true);
    expect(isGitLabOAuthAccessToken('rotating-access-token')).toBe(true);
    expect(isGitLabOAuthAccessToken('glpat-personal-token')).toBe(false);
    expect(isGitLabOAuthAccessToken('acme-pat-abc123')).toBe(false);
  });

  it('waits for an in-flight refresh and prevents it from recreating the connection', async () => {
    executeMock.mockResolvedValue([{ value: 'encrypted-connection' }]);
    decryptMock.mockResolvedValue({
      baseUrl: 'https://gitlab.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountId: '42',
      username: 'roomote',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(0).toISOString(),
      scopes: ['api'],
      status: 'active',
    });
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => (resolveResponse = resolve)),
    );

    const refresh = resolveGitLabOAuthAccessToken({
      fetchImpl: fetchImpl as typeof fetch,
      forceRefresh: true,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const deletion = deleteGitLabOAuthConnection();
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
});

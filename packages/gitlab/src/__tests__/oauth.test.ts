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

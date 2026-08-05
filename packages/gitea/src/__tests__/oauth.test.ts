import { describe, expect, it, vi } from 'vitest';

const { deleteWhereMock, deleteMock, insertMock } = vi.hoisted(() => {
  const deleteWhereMock = vi.fn(async () => undefined);
  return {
    deleteWhereMock,
    deleteMock: vi.fn(() => ({ where: deleteWhereMock })),
    insertMock: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => undefined),
      })),
    })),
  };
});

vi.mock('@roomote/db/server', () => ({
  db: { delete: deleteMock, insert: insertMock },
  deploymentSecrets: { name: 'deployment_secrets.name' },
  eq: (left: unknown, right: unknown) => ({ left, right }),
}));

vi.mock('@roomote/db/encryption', () => ({
  decryptSecrets: vi.fn(),
  encryptJSON: vi.fn(() => 'encrypted-connection'),
}));

import {
  buildGiteaOAuthRedirectUri,
  createGiteaOAuthAuthorizationUrl,
  deleteGiteaOAuthConnection,
  exchangeGiteaOAuthCode,
  getGiteaOAuthScopes,
  isGiteaOAuthAccessToken,
} from '../oauth';

describe('Gitea deployment OAuth', () => {
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
    expect(isGiteaOAuthAccessToken('gitea-access-token')).toBe(true);

    await deleteGiteaOAuthConnection();

    expect(deleteWhereMock).toHaveBeenCalledOnce();
    expect(isGiteaOAuthAccessToken('gitea-access-token')).toBe(false);
  });
});

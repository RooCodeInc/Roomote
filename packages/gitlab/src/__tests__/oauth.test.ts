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
  sql: vi.fn(),
}));

vi.mock('@roomote/db/encryption', () => ({
  decryptSecrets: vi.fn(),
  encryptJSON: vi.fn(() => 'encrypted-connection'),
}));

import {
  buildGitLabOAuthRedirectUri,
  createGitLabOAuthAuthorizationUrl,
  deleteGitLabOAuthConnection,
  exchangeGitLabOAuthCode,
  isGitLabOAuthAccessToken,
} from '../oauth';

describe('GitLab deployment OAuth', () => {
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
});

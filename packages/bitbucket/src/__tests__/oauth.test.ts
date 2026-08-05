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
  BITBUCKET_OAUTH_CALLBACK_PATH,
  buildBitbucketOAuthRedirectUri,
  createBitbucketOAuthAuthorizationUrl,
  deleteBitbucketOAuthConnection,
  exchangeBitbucketOAuthCode,
  getBitbucketOAuthScopes,
  isBitbucketOAuthAccessToken,
} from '../oauth';

describe('Bitbucket deployment OAuth', () => {
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
    expect(isBitbucketOAuthAccessToken('bitbucket-access-token')).toBe(true);

    await deleteBitbucketOAuthConnection();

    expect(deleteWhereMock).toHaveBeenCalledOnce();
    expect(isBitbucketOAuthAccessToken('bitbucket-access-token')).toBe(false);
  });
});

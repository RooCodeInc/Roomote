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
    expect(isBitbucketOAuthAccessToken('bitbucket-access-token')).toBe(true);

    await deleteBitbucketOAuthConnection();

    expect(deleteWhereMock).toHaveBeenCalledOnce();
    expect(isBitbucketOAuthAccessToken('bitbucket-access-token')).toBe(false);
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
});

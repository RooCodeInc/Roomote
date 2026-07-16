import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

const {
  mockDbTransaction,
  mockFetch,
  mockUpsertDeploymentEnvironmentVariables,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockFetch: vi.fn(),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  buildSlackApiUrl: (path: string) => `https://slack.example.test/api/${path}`,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: mockDbTransaction,
  },
}));

vi.mock('@/lib/server', () => ({
  Env: {
    R_APP_URL: 'https://roomote.example.com/',
  },
}));

vi.mock('../environment-variables', () => ({
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
}));

vi.stubGlobal('fetch', mockFetch);

import { createSlackAppFromManifestCommand } from './create-app-from-manifest';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'slack-manifest-test-user',
    isAdmin: true,
    name: 'Slack Manifest Tester',
    primaryEmail: 'slack@example.com',
    featureFlags: {} as Record<FeatureFlag, boolean>,
    resource: {
      username: 'slack-manifest-tester',
      fullName: 'Slack Manifest Tester',
      firstName: 'Slack',
      lastName: 'Tester',
      primaryEmailAddress: { id: '1', emailAddress: 'slack@example.com' },
      emailAddresses: [{ id: '1', emailAddress: 'slack@example.com' }],
      imageUrl: 'https://example.com/avatar.png',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;
}

function mockSlackResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('createSlackAppFromManifestCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbTransaction.mockImplementation(async (callback) =>
      callback({ kind: 'tx' }),
    );
  });

  it('rejects non-admin users without calling Slack', async () => {
    const result = await createSlackAppFromManifestCommand(
      buildMockAuth({ isAdmin: false }),
      { configToken: 'xoxe.xoxp-token' },
    );

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('creates the app and persists the three Slack env vars in one transaction', async () => {
    mockSlackResponse({
      ok: true,
      app_id: 'A0NEWAPP',
      credentials: {
        client_id: 'new-client-id',
        client_secret: 'new-client-secret',
        verification_token: 'new-verification-token',
        signing_secret: 'new-signing-secret',
      },
      oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=x',
    });

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: '  xoxe.xoxp-token  ',
    });

    expect(result).toEqual({
      success: true,
      appId: 'A0NEWAPP',
      appSettingsUrl: 'https://api.slack.com/apps/A0NEWAPP',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.example.test/api/apps.manifest.create');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer xoxe.xoxp-token',
    );

    const body = JSON.parse(String(init.body)) as { manifest: string };
    const manifest = JSON.parse(body.manifest);
    expect(manifest).toMatchObject({
      display_information: { name: 'Roomote' },
      settings: {
        event_subscriptions: {
          request_url: 'https://roomote.example.com/api/webhooks/slack',
        },
      },
    });

    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      { kind: 'tx' },
      {
        userId: 'slack-manifest-test-user',
        values: [
          { name: 'R_SLACK_CLIENT_ID', value: 'new-client-id' },
          { name: 'R_SLACK_CLIENT_SECRET', value: 'new-client-secret' },
          { name: 'R_SLACK_SIGNING_SECRET', value: 'new-signing-secret' },
        ],
      },
    );
  });

  it('deletes the created Slack app when persisting credentials fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          app_id: 'A0NEWAPP',
          credentials: {
            client_id: 'new-client-id',
            client_secret: 'new-client-secret',
            verification_token: 'new-verification-token',
            signing_secret: 'new-signing-secret',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    mockDbTransaction.mockRejectedValue(new Error('database is unavailable'));

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-token',
    });

    expect(result).toEqual({
      success: false,
      error:
        'Slack app credentials could not be saved. The Slack app was deleted automatically; try again when the issue is resolved.',
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [deleteUrl, deleteInit] = mockFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(deleteUrl).toBe(
      'https://slack.example.test/api/apps.manifest.delete',
    );
    expect(deleteInit.method).toBe('POST');
    expect((deleteInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer xoxe.xoxp-token',
    );
    expect(JSON.parse(String(deleteInit.body))).toEqual({ app_id: 'A0NEWAPP' });
  });

  it('returns a recovery path when cleanup after persistence failure fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          app_id: 'A0NEWAPP',
          credentials: {
            client_id: 'new-client-id',
            client_secret: 'new-client-secret',
            verification_token: 'new-verification-token',
            signing_secret: 'new-signing-secret',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: 'app_not_found' }),
      });
    mockDbTransaction.mockRejectedValue(new Error('database is unavailable'));

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-token',
    });

    expect(result).toEqual({
      success: false,
      error:
        'Slack app credentials could not be saved. The Slack app A0NEWAPP was created but could not be deleted automatically; delete it from api.slack.com/apps before trying again.',
    });
  });

  it('maps configuration-token failures to an actionable error', async () => {
    mockSlackResponse({ ok: false, error: 'invalid_auth' });

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-expired',
    });

    expect(result).toEqual({
      success: false,
      error:
        'Slack rejected the app configuration token. Generate a fresh token at api.slack.com/apps and try again.',
    });
    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('surfaces structured manifest validation errors', async () => {
    mockSlackResponse({
      ok: false,
      error: 'invalid_manifest',
      errors: [
        { message: 'invalid scope', pointer: '/oauth_config/scopes/bot' },
        { message: 'missing bot user' },
      ],
    });

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-token',
    });

    expect(result).toEqual({
      success: false,
      error:
        'Slack rejected the generated app manifest: invalid scope (/oauth_config/scopes/bot); missing bot user',
    });
    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('fails when Slack omits credentials from a successful response', async () => {
    mockSlackResponse({
      ok: true,
      app_id: 'A0NEWAPP',
      credentials: {
        client_id: 'new-client-id',
      },
    });

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-token',
    });

    expect(result).toEqual({
      success: false,
      error:
        'Slack returned an incomplete app creation response. The Slack app was deleted automatically; try again when the issue is resolved.',
    });
    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('fails with an HTTP error when the response body is not JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-token',
    });

    expect(result).toEqual({
      success: false,
      error: 'Failed to create the Slack app (HTTP 502). Please try again.',
    });
    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });
});

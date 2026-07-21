import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

const {
  mockDbTransaction,
  mockFetch,
  mockReadFile,
  mockUpsertDeploymentEnvironmentVariables,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockFetch: vi.fn(),
  mockReadFile: vi.fn(),
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
    R_APP_URL: 'http://localhost:3000/',
    R_PUBLIC_URL: 'https://roomote.example.com/',
  },
}));

vi.mock('../environment-variables', () => ({
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
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

function mockSuccessfulCreateResponse() {
  return {
    ok: true,
    app_id: 'A0NEWAPP',
    credentials: {
      client_id: 'new-client-id',
      client_secret: 'new-client-secret',
      verification_token: 'new-verification-token',
      signing_secret: 'new-signing-secret',
    },
    oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=x',
  };
}

describe('createSlackAppFromManifestCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbTransaction.mockImplementation(async (callback) =>
      callback({ kind: 'tx' }),
    );
    mockReadFile.mockResolvedValue(Buffer.from('fake-png-bytes'));
  });

  it('rejects non-admin users without calling Slack', async () => {
    const result = await createSlackAppFromManifestCommand(
      buildMockAuth({ isAdmin: false }),
      { configToken: 'xoxe.xoxp-token' },
    );

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('creates the app, sets the icon, and persists the three Slack env vars', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockSuccessfulCreateResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: '  xoxe.xoxp-token  ',
    });

    expect(result).toEqual({
      success: true,
      appId: 'A0NEWAPP',
      appSettingsUrl: 'https://api.slack.com/apps/A0NEWAPP',
      iconSet: true,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(createUrl).toBe(
      'https://slack.example.test/api/apps.manifest.create',
    );
    expect(createInit.method).toBe('POST');
    expect((createInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer xoxe.xoxp-token',
    );

    const body = JSON.parse(String(createInit.body)) as { manifest: string };
    const manifest = JSON.parse(body.manifest);
    expect(manifest).toMatchObject({
      display_information: { name: 'Roomote' },
      settings: {
        event_subscriptions: {
          request_url: 'https://roomote.example.com/api/webhooks/slack',
        },
      },
      oauth_config: {
        redirect_urls: [
          'https://roomote.example.com/api/auth/oauth2/callback/slack',
          'https://roomote.example.com/api/slack/callback',
        ],
      },
    });
    expect(JSON.stringify(manifest)).not.toContain('localhost');

    const [iconUrl, iconInit] = mockFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(iconUrl).toBe('https://slack.example.test/api/apps.icon.set');
    expect(iconInit.method).toBe('POST');
    expect((iconInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer xoxe.xoxp-token',
    );
    expect(iconInit.body).toBeInstanceOf(FormData);
    const iconBody = iconInit.body as FormData;
    expect(iconBody.get('app_id')).toBe('A0NEWAPP');
    expect(iconBody.get('file')).toBeInstanceOf(Blob);

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

  it('still succeeds when the app icon cannot be set', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockSuccessfulCreateResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: 'invalid_icon_size' }),
      });

    const result = await createSlackAppFromManifestCommand(buildMockAuth(), {
      configToken: 'xoxe.xoxp-token',
    });

    expect(result).toEqual({
      success: true,
      appId: 'A0NEWAPP',
      appSettingsUrl: 'https://api.slack.com/apps/A0NEWAPP',
      iconSet: false,
    });
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalled();
  });

  it('deletes the created Slack app when persisting credentials fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockSuccessfulCreateResponse(),
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
        json: async () => mockSuccessfulCreateResponse(),
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

  it('returns a recovery path when cleanup rejects after persistence failure', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockSuccessfulCreateResponse(),
      })
      .mockRejectedValueOnce(new Error('network down'));
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
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          app_id: 'A0NEWAPP',
          credentials: {
            client_id: 'new-client-id',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
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

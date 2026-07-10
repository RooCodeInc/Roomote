import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';
import { decodeRecord } from '@/lib';

const {
  mockDbTransaction,
  mockFetch,
  mockResolveDeploymentEnvVar,
  mockUpsertDeploymentEnvironmentVariables,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockFetch: vi.fn(),
  mockResolveDeploymentEnvVar: vi.fn(),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createAuthToken: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  getAppOctokit: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  createClient: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: mockDbTransaction,
    query: {
      githubInstallations: {
        findMany: vi.fn(),
      },
    },
  },
  githubInstallations: {},
  githubPendingInstallations: {},
  githubUserMappings: {},
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
  repositories: {},
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
}));

vi.mock('@/lib/server', () => ({
  Env: {
    ROOMOTE_APP_URL: 'https://roomote.example.com',
    TRPC_URL: 'http://localhost:3000',
    NEXT_PUBLIC_GITHUB_APP_SLUG: 'roomote',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
  },
}));

vi.mock('../environment-variables', () => ({
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
}));

vi.stubGlobal('fetch', mockFetch);

import {
  finishCreateGitHubAppManifestCommand,
  startCreateGitHubInstallationCommand,
  startCreateGitHubAppManifestCommand,
} from './mutations';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'github-manifest-test-user',
    isAdmin: true,
    name: 'GitHub Manifest Tester',
    primaryEmail: 'github@example.com',
    featureFlags: {} as Record<FeatureFlag, boolean>,
    resource: {
      username: 'github-manifest-tester',
      fullName: 'GitHub Manifest Tester',
      firstName: 'GitHub',
      lastName: 'Tester',
      primaryEmailAddress: { id: '1', emailAddress: 'github@example.com' },
      emailAddresses: [{ id: '1', emailAddress: 'github@example.com' }],
      imageUrl: 'https://example.com/avatar.png',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;
}

describe('GitHub App manifest commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbTransaction.mockImplementation(async (callback) =>
      callback({ kind: 'tx' }),
    );
    mockResolveDeploymentEnvVar.mockResolvedValue('created-roomote-app');
  });

  it('builds a manifest POST payload with Roomote URLs, permissions, events, and install flags', async () => {
    const result = await startCreateGitHubAppManifestCommand(buildMockAuth(), {
      mode: 'github-app-manifest',
      redirect: '/setup?step=source-control-connect',
    });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    const postTarget = new URL(result.postTarget);
    expect(`${postTarget.origin}${postTarget.pathname}`).toBe(
      'https://github.com/settings/apps/new',
    );
    expect(decodeRecord(postTarget.searchParams.get('state') ?? '')).toEqual({
      mode: 'github-app-manifest',
      redirect: '/setup?step=source-control-connect',
    });

    const manifest = JSON.parse(result.values.manifest);
    expect(manifest.name).toBe('roomote-example-com');
    expect(manifest.name.length).toBeLessThanOrEqual(34);
    expect(manifest).toMatchObject({
      url: 'https://roomote.example.com/github/callback',
      redirect_url: 'https://roomote.example.com/github/callback',
      setup_url: 'https://roomote.example.com/github/callback',
      callback_urls: ['https://roomote.example.com/github/callback'],
      hook_attributes: {
        url: 'https://roomote.example.com/api/webhooks/github',
        active: true,
      },
      default_permissions: {
        contents: 'write',
        issues: 'write',
        metadata: 'read',
        pull_requests: 'write',
        workflows: 'write',
      },
      default_events: [
        'issue_comment',
        'pull_request',
        'pull_request_review_comment',
        'push',
        'workflow_run',
      ],
      request_oauth_on_install: true,
      setup_on_update: true,
      public: false,
    });
  });

  it('targets the organization manifest endpoint when an organization is provided', async () => {
    const result = await startCreateGitHubAppManifestCommand(
      buildMockAuth(),
      {
        mode: 'github-app-manifest',
        redirect: '/setup?step=source-control-connect',
      },
      'roovetgit',
    );

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    const postTarget = new URL(result.postTarget);
    expect(`${postTarget.origin}${postTarget.pathname}`).toBe(
      'https://github.com/organizations/roovetgit/settings/apps/new',
    );
    expect(decodeRecord(postTarget.searchParams.get('state') ?? '')).toEqual({
      mode: 'github-app-manifest',
      redirect: '/setup?step=source-control-connect',
    });
  });

  it('trims the organization and keeps the personal target when it is blank', async () => {
    const result = await startCreateGitHubAppManifestCommand(
      buildMockAuth(),
      undefined,
      '   ',
    );

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.postTarget).toBe('https://github.com/settings/apps/new');
  });

  it('rejects an invalid organization name', async () => {
    const result = await startCreateGitHubAppManifestCommand(
      buildMockAuth(),
      undefined,
      'not a valid org!',
    );

    expect(result).toEqual({
      success: false,
      error:
        'Enter a valid GitHub organization name (letters, numbers, and hyphens only).',
    });
  });

  it('converts a manifest code and persists all returned GitHub App env vars', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 12345,
          slug: 'created-roomote-app',
          client_id: 'Iv1.client',
          client_secret: 'client-secret-value',
          webhook_secret: 'webhook-secret-value',
          pem: '-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----\n',
        }),
        { status: 201 },
      ),
    );

    const result = await finishCreateGitHubAppManifestCommand(buildMockAuth(), {
      code: 'temporary-code',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/app-manifests/temporary-code/conversions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      }),
    );
    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: 'github-manifest-test-user',
        values: [
          { name: 'GITHUB_APP_ID', value: '12345' },
          {
            name: 'GITHUB_APP_PRIVATE_KEY',
            value:
              '-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----\n',
          },
          { name: 'GITHUB_CLIENT_ID', value: 'Iv1.client' },
          { name: 'GITHUB_CLIENT_SECRET', value: 'client-secret-value' },
          { name: 'GITHUB_WEBHOOK_SECRET', value: 'webhook-secret-value' },
          {
            name: 'NEXT_PUBLIC_GITHUB_APP_SLUG',
            value: 'created-roomote-app',
          },
        ],
      },
    );
    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    const installUrl = new URL(result.installUrl);
    expect(`${installUrl.origin}${installUrl.pathname}`).toBe(
      'https://github.com/apps/created-roomote-app/installations/new',
    );
    expect(decodeRecord(installUrl.searchParams.get('state') ?? '')).toEqual({
      mode: 'github-app-install',
      redirect: '/setup?step=source-control-connect',
    });
    expect(installUrl.searchParams.get('redirect_url')).toBe(
      'https://roomote.example.com/github/callback',
    );
  });

  it('uses the GITHUB_APP_SLUG alias when building the install URL', async () => {
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) => {
      switch (name) {
        case 'GITHUB_APP_SLUG':
          return 'aliased-roomote-app';
        case 'GITHUB_APP_ID':
        case 'GITHUB_APP_PRIVATE_KEY':
        case 'GITHUB_CLIENT_ID':
        case 'GITHUB_CLIENT_SECRET':
        case 'GITHUB_WEBHOOK_SECRET':
          return 'configured-value';
        default:
          return null;
      }
    });

    const result = await startCreateGitHubInstallationCommand(buildMockAuth(), {
      redirect: '/setup?step=source-control-connect',
    });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(new URL(result.url).pathname).toBe(
      '/apps/aliased-roomote-app/installations/new',
    );
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledWith(
      'NEXT_PUBLIC_GITHUB_APP_SLUG',
    );
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledWith('GITHUB_APP_SLUG');
  });

  it('refuses to start installation when GitHub App credentials are not configured', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValue(null);

    const result = await startCreateGitHubInstallationCommand(buildMockAuth(), {
      redirect: '/settings?tab=source-control',
    });

    expect(result).toEqual({
      success: false,
      error:
        'Configure a GitHub App for this deployment before installing. Create one or enter its credentials first.',
    });
  });

  it('preserves the caller redirect after finishing app manifest creation', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 12345,
          slug: 'created-roomote-app',
          client_id: 'client-id-value',
          client_secret: 'client-secret-value',
          webhook_secret: 'webhook-secret-value',
          pem: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
        }),
        { status: 201 },
      ),
    );
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) => {
      switch (name) {
        case 'NEXT_PUBLIC_GITHUB_APP_SLUG':
          return 'created-roomote-app';
        case 'GITHUB_APP_ID':
        case 'GITHUB_APP_PRIVATE_KEY':
        case 'GITHUB_CLIENT_ID':
        case 'GITHUB_CLIENT_SECRET':
        case 'GITHUB_WEBHOOK_SECRET':
          return 'configured-value';
        default:
          return null;
      }
    });

    const result = await finishCreateGitHubAppManifestCommand(buildMockAuth(), {
      code: 'manifest-code',
      redirect: '/settings?tab=source-control',
    });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    const installUrl = new URL(result.installUrl);
    expect(decodeRecord(installUrl.searchParams.get('state') ?? '')).toEqual({
      mode: 'github-app-install',
      redirect: '/settings?tab=source-control',
    });
  });

  it('returns a user-facing error and does not save env vars when conversion fails', async () => {
    mockFetch.mockResolvedValue(new Response('not found', { status: 404 }));

    const result = await finishCreateGitHubAppManifestCommand(buildMockAuth(), {
      code: 'expired-code',
    });

    expect(result).toEqual({
      success: false,
      error: 'Failed to create GitHub App from manifest. Please try again.',
    });
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });
});

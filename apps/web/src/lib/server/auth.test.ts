const {
  genericOAuthCalls,
  mockBetterAuth,
  mockGenericOAuth,
  mockResolveAuthProviderConfig,
} = vi.hoisted(() => {
  const calls: Array<{
    config: Array<{
      providerId?: string;
      getUserInfo?: (tokens: { accessToken?: string }) => Promise<unknown>;
      [key: string]: unknown;
    }>;
  }> = [];
  return {
    genericOAuthCalls: calls,
    mockBetterAuth: vi.fn((options) => ({
      api: {
        getSession: vi.fn(),
      },
      handler: vi.fn(),
      options,
    })),
    mockGenericOAuth: vi.fn((options) => {
      calls.push(options);
      return { id: 'generic-oauth-plugin', options };
    }),
    mockResolveAuthProviderConfig: vi.fn(),
  };
});

vi.mock('better-auth', () => ({
  betterAuth: mockBetterAuth,
}));

vi.mock('better-auth/next-js', () => ({
  nextCookies: () => ({ id: 'next-cookies-plugin' }),
}));

vi.mock('better-auth/plugins', () => ({
  genericOAuth: mockGenericOAuth,
  microsoftEntraId: vi.fn((options) => ({
    providerId: 'microsoft-entra-id',
    ...options,
  })),
  slack: vi.fn((options) => ({
    providerId: 'slack',
    ...options,
  })),
}));

vi.mock('@better-auth/drizzle-adapter', () => ({
  drizzleAdapter: vi.fn(() => ({ id: 'drizzle-adapter' })),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  authUsers: {},
  db: {},
  eq: vi.fn(),
  inArray: vi.fn(),
  microsoftAuthUserMappings: {},
  teamsUserMappings: {},
}));

vi.mock('./access-policy', () => ({
  isNewAuthUserEmailAllowed: vi.fn(() => true),
  isSignInAllowedByAccessPolicy: vi.fn(() => true),
}));

vi.mock('./auth-provider-config', () => ({
  resolveAuthProviderConfig: mockResolveAuthProviderConfig,
}));

vi.mock('./better-auth-base-url', () => ({
  getBetterAuthBaseUrlConfig: vi.fn(() => 'http://localhost:3000'),
}));

vi.mock('./bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: vi.fn(),
}));

vi.mock('./env', () => ({
  Env: {
    ENCRYPTION_KEY: 'test-encryption-key',
    R_ALLOWED_EMAILS: undefined,
    R_APP_URL: 'http://localhost:3000',
  },
  getEncryptionKey: () => 'test-encryption-key',
  getBetterAuthSecret: () => 'test-better-auth-secret',
}));

vi.mock('./invite-context', () => ({
  extractInviteTokenFromRequest: vi.fn(),
  runWithInviteContext: vi.fn((_token, callback) => callback()),
}));

vi.mock('./canonical-forwarded-proto', () => ({
  withCanonicalForwardedProto: vi.fn((request) => request),
}));

import { getAuth } from './auth';

function getAdoOAuthProvider() {
  const config = genericOAuthCalls.at(-1)?.config;
  const provider = config?.find((item) => item.providerId === 'ado');

  if (!provider?.getUserInfo) {
    throw new Error('ADO OAuth provider was not configured');
  }

  return provider;
}

describe('getAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    genericOAuthCalls.length = 0;
    mockResolveAuthProviderConfig.mockResolvedValue({
      adoBaseUrl: 'https://dev.azure.com',
      adoClientId: 'ado-client-id',
      adoClientSecret: 'ado-client-secret',
      adoOrganization: 'ado-organization',
      adoTenantId: 'roomote-tenant-id',
      gitlabBaseUrl: undefined,
      gitlabClientId: undefined,
      gitlabClientSecret: undefined,
      microsoftClientId: undefined,
      microsoftClientSecret: undefined,
      microsoftTenantId: undefined,
      signature: crypto.randomUUID(),
      slackClientId: undefined,
      slackClientSecret: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables the session freshness gate so linked accounts can be unlinked', async () => {
    await getAuth();

    const options = mockBetterAuth.mock.calls.at(-1)?.[0] as
      | { session?: { freshAge?: number } }
      | undefined;

    expect(options?.session?.freshAge).toBe(0);
  });

  it('keys the Entra linked-account identity on the normalized uniqueName', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href.includes('/_apis/connectionData')) {
        return Response.json({
          authenticatedUser: {
            id: 'connection-user-guid',
            providerDisplayName: 'Ada Lovelace',
            uniqueName: 'Ada@Roomote.OnMicrosoft.com',
          },
        });
      }

      return Response.json({
        displayName: 'Ada Lovelace',
        emailAddress: 'ada@roomote.onmicrosoft.com',
        id: 'profile-user-guid',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await getAuth();

    const provider = getAdoOAuthProvider();
    const profile = await provider.getUserInfo?.({
      accessToken: 'azure-devops-token',
    });

    expect(provider.authorizationUrl).toBe(
      'https://login.microsoftonline.com/roomote-tenant-id/oauth2/v2.0/authorize',
    );
    expect(provider.tokenUrl).toBe(
      'https://login.microsoftonline.com/roomote-tenant-id/oauth2/v2.0/token',
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://app.vssps.visualstudio.com/_apis/connectionData?api-version=7.1-preview',
      {
        headers: {
          Authorization: 'Bearer azure-devops-token',
        },
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
      {
        headers: {
          Authorization: 'Bearer azure-devops-token',
        },
      },
    );
    // The account id is the normalized uniqueName (UPN/email), not the vssps
    // connectionData id — that id namespace never matches the org identity id
    // Azure DevOps delivers as the comment author on PR webhooks.
    expect(profile).toEqual({
      email: 'ada@roomote.onmicrosoft.com',
      emailVerified: false,
      id: 'ada@roomote.onmicrosoft.com',
      name: 'Ada Lovelace',
    });
  });
});

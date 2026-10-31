import { generateKeyPairSync, sign } from 'node:crypto';
import { authAccounts, authUsers, db, eq } from '@roomote/db/server';

vi.mock('./bootstrap-runtime-env', () => ({ bootstrapWebRuntimeEnv: vi.fn() }));
vi.mock('./auth-provider-config', () => ({
  resolveAuthProviderConfig: vi.fn(),
}));
vi.mock('./better-auth-base-url', () => ({
  getBetterAuthBaseUrlConfig: () => ({
    allowedHosts: ['auth.example.test', 'preview.example.test'],
    protocol: 'https',
  }),
}));
vi.mock('./env', () => ({
  Env: { R_APP_URL: 'https://auth.example.test' },
  getBetterAuthSecret: () => 'oauth-integration-test-secret-long-enough',
  isEmailChannelEnabled: () => false,
}));
vi.mock('./access-policy', () => ({
  isNewAuthUserEmailAllowed: async () => true,
  isSignInAllowedByAccessPolicy: async () => true,
}));
vi.mock('./license', () => ({ hasSeatAvailable: async () => true }));

import { resolveAuthProviderConfig } from './auth-provider-config';
import { handleAuthRequest } from './auth';

const TENANT = '12345678-1234-1234-1234-123456789abc';
const CONSUMER = '9188040d-6c67-4c5b-b112-36a304b66dad';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture',
  alg: 'RS256',
  use: 'sig',
};
let subject: string;
let tenantClaim: string;
let exchanges: URLSearchParams[];
let userIds: string[];
let extraClaims: Record<string, unknown>;
let tokenNonce: string | null;

function jwt() {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'fixture' })}.${encode({
    sub: subject,
    oid: `different-oid-${subject}`,
    tid: tenantClaim,
    iss: `https://login.microsoftonline.com/${tenantClaim}/v2.0`,
    aud: 'fixture-client',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: `${subject}@example.test`,
    nonce: tokenNonce,
    name: 'OAuth Fixture',
    email_verified: true,
    ...extraClaims,
  })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function request(
  path: string,
  body?: object,
  cookie = '',
  host = 'auth.example.test',
) {
  return handleAuthRequest(
    new Request(`https://${host}/api/auth/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: `https://${host}`,
        cookie,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

async function start(
  provider: string,
  cookie = '',
  host = 'auth.example.test',
) {
  const response = await request(
    cookie ? 'link-social' : 'sign-in/social',
    {
      provider,
      callbackURL: '/settings/personal',
      disableRedirect: true,
    },
    cookie,
    host,
  );
  expect(response.status).toBe(200);
  const url = new URL((await response.json()).url);
  expect(url.searchParams.get('redirect_uri')).toBe(
    `https://${host}/api/auth/oauth2/callback/${provider}`,
  );
  return { response, url };
}

async function finish(
  provider: string,
  started: Awaited<ReturnType<typeof start>>,
  post = false,
) {
  tokenNonce = started.url.searchParams.get('nonce');
  const callback = new URL(started.url.searchParams.get('redirect_uri')!);
  const params = new URLSearchParams({
    code: 'normal-fixture-code',
    state: started.url.searchParams.get('state')!,
  });
  if (!post) callback.search = params.toString();
  return handleAuthRequest(
    new Request(callback, {
      method: post ? 'POST' : 'GET',
      headers: {
        cookie: cookies(started.response),
        ...(post
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(post ? { body: params.toString() } : {}),
    }),
  );
}

beforeEach(() => {
  subject = crypto.randomUUID();
  tenantClaim = TENANT;
  exchanges = [];
  userIds = [];
  extraClaims = {};
  vi.mocked(resolveAuthProviderConfig).mockResolvedValue({
    signature: crypto.randomUUID(),
    slackClientId: 'fixture-client',
    slackClientSecret: 'fixture-secret',
    microsoftClientId: 'fixture-client',
    microsoftClientSecret: 'fixture-secret',
    microsoftTenantId: TENANT,
    gitlabClientId: 'fixture-client',
    gitlabClientSecret: 'fixture-secret',
    gitlabBaseUrl: 'https://gitlab.example.test',
    giteaClientId: 'fixture-client',
    giteaClientSecret: 'fixture-secret',
    giteaBaseUrl: 'https://gitea.example.test',
    bitbucketClientId: 'fixture-client',
    bitbucketClientSecret: 'fixture-secret',
    bitbucketBaseUrl: 'https://bitbucket.org',
    adoClientId: 'fixture-client',
    adoClientSecret: 'fixture-secret',
    adoOrganization: 'fixture',
    adoTenantId: 'common',
  } as Awaited<ReturnType<typeof resolveAuthProviderConfig>>);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname.endsWith('/keys')) return Response.json({ keys: [jwk] });
      if (
        url.pathname.endsWith('/token') ||
        url.pathname.endsWith('/access_token') ||
        url.pathname.endsWith('openid.connect.token')
      ) {
        exchanges.push(new URLSearchParams(String(init?.body)));
        return Response.json({
          access_token: 'fixture-access',
          token_type: 'Bearer',
          expires_in: 3600,
          ...(url.hostname === 'login.microsoftonline.com'
            ? { id_token: jwt() }
            : {}),
        });
      }
      if (url.pathname.endsWith('openid.connect.userInfo')) {
        return Response.json({
          sub: subject,
          email: `${subject}@example.test`,
          name: 'Slack Fixture',
          email_verified: true,
        });
      }
      if (
        url.hostname === 'graph.microsoft.com' &&
        url.pathname === '/oidc/userinfo'
      ) {
        return Response.json({
          sub: subject,
          preferred_username: `${subject}@example.test`,
          given_name: 'Microsoft',
          family_name: 'Fixture',
        });
      }
      if (url.pathname === '/api/v4/user') {
        return Response.json({
          id: subject,
          username: 'fixture',
          email: `${subject}@example.test`,
          name: 'GitLab Fixture',
        });
      }
      if (url.pathname === '/api/v1/user')
        return Response.json({
          id: subject,
          login: 'fixture',
          email: `${subject}@example.test`,
        });
      if (url.pathname === '/2.0/user')
        return Response.json({ account_id: subject, display_name: 'Fixture' });
      if (url.pathname === '/_apis/connectionData')
        return Response.json({
          authenticatedUser: {
            id: subject,
            uniqueName: `${subject}@example.test`,
            displayName: 'Fixture',
          },
        });
      if (url.pathname === '/_apis/profile/profiles/me')
        return Response.json({
          id: subject,
          emailAddress: `${subject}@example.test`,
        });
      throw new Error(
        `Unexpected provider request: ${url.origin}${url.pathname}`,
      );
    }),
  );
});

afterEach(async () => {
  for (const id of userIds)
    await db.delete(authUsers).where(eq(authUsers.id, id));
  vi.unstubAllGlobals();
});

async function existingUser(providerId: string) {
  const id = crypto.randomUUID();
  userIds.push(id);
  await db.insert(authUsers).values({
    id,
    name: 'Returning Fixture',
    email: `${subject}@example.test`,
    emailVerified: true,
  });
  const accountId = crypto.randomUUID();
  await db
    .insert(authAccounts)
    .values({ id: accountId, userId: id, providerId, accountId: subject });
  return { id, accountId };
}

it.each(['slack', 'microsoft-entra-id', 'gitlab', 'gitea', 'bitbucket', 'ado'])(
  'initiates %s through real core sign-in and preserves registered preview callbacks',
  async (provider) => {
    await start(provider, '', 'preview.example.test');
  },
);

it('creates a fresh Slack nonce for each authorization request and retains scopes', async () => {
  const a = await start('slack');
  const b = await start('slack');
  expect(a.url.searchParams.get('nonce')).toBeTruthy();
  expect(b.url.searchParams.get('nonce')).not.toBe(
    a.url.searchParams.get('nonce'),
  );
  expect(a.url.searchParams.get('scope')?.split(' ')).toEqual(
    expect.arrayContaining(['openid', 'profile', 'email']),
  );
});

it.each([false, true])(
  'completes Slack returning-user callback (POST=%s) without duplicating identity',
  async (post) => {
    const user = await existingUser('slack');
    const started = await start('slack');
    const response = await finish('slack', started, post);
    // Core turns form_post into a same-origin GET before completing the flow.
    const completed =
      post && response.headers.get('location')?.includes('/callback/')
        ? await handleAuthRequest(
            new Request(
              new URL(
                response.headers.get('location')!,
                'https://auth.example.test',
              ),
              { headers: { cookie: cookies(started.response) } },
            ),
          )
        : response;
    expect(completed.status).toBe(302);
    expect(completed.headers.get('location')).toBe('/settings/personal');
    const session = await request('get-session', undefined, cookies(completed));
    expect((await session.json()).user.id).toBe(user.id);
    expect(
      (
        await db.query.authAccounts.findMany({
          where: eq(authAccounts.userId, user.id),
        })
      ).map((a) => a.id),
    ).toEqual([user.accountId]);
    expect(exchanges[0]?.get('redirect_uri')).toBe(
      started.url.searchParams.get('redirect_uri'),
    );
  },
);

it.each([TENANT, 'common', 'organizations', 'consumers'])(
  'retains Microsoft sub identity and validated sign-in for tenant %s',
  async (tenant) => {
    const config = await resolveAuthProviderConfig();
    vi.mocked(resolveAuthProviderConfig).mockResolvedValue({
      ...config,
      signature: crypto.randomUUID(),
      microsoftTenantId: tenant,
    });
    if (tenant === 'consumers') tenantClaim = CONSUMER;
    const user = await existingUser('microsoft-entra-id');
    const started = await start('microsoft-entra-id');
    const response = await finish('microsoft-entra-id', started);
    expect(response.headers.get('location')).toBe('/settings/personal');
    const session = await request('get-session', undefined, cookies(response));
    expect((await session.json()).user.id).toBe(user.id);
    const accounts = await db.query.authAccounts.findMany({
      where: eq(authAccounts.userId, user.id),
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: user.accountId,
      accountId: subject,
      providerId: 'microsoft-entra-id',
    });
    expect(exchanges[0]?.get('redirect_uri')).toBe(
      started.url.searchParams.get('redirect_uri'),
    );
  },
);

it.each(['slack', 'microsoft-entra-id', 'gitlab', 'gitea', 'bitbucket', 'ado'])(
  'links %s to an existing real session',
  async (provider) => {
    const signup = await request('sign-up/email', {
      email: `${subject}@example.test`,
      name: 'Link Fixture',
      password: 'fixture-password-123!',
    });
    expect(signup.status).toBe(200);
    const id = (await signup.json()).user.id as string;
    userIds.push(id);
    const started = await start(provider, cookies(signup));
    const response = await finish(provider, started);
    expect(response.headers.get('location')).toBe('/settings/personal');
    expect(
      await db.query.authAccounts.findFirst({
        where: eq(
          authAccounts.accountId,
          provider === 'ado' ? `${subject}@example.test` : subject,
        ),
      }),
    ).toMatchObject({ userId: id, providerId: provider });
  },
);

it('retains returning generic OAuth sign-in by existing provider identity', async () => {
  const user = await existingUser('gitlab');
  const response = await finish('gitlab', await start('gitlab'));
  expect(response.headers.get('location')).toBe('/settings/personal');
  expect(
    (await (await request('get-session', undefined, cookies(response))).json())
      .user.id,
  ).toBe(user.id);
});

it.each(['gitlab', 'microsoft-entra-id'])(
  'keeps unverified %s profiles out of implicit email linking',
  async (provider) => {
    const signup = await request('sign-up/email', {
      email: `${subject}@example.test`,
      name: 'Existing Fixture',
      password: 'fixture-password-123!',
    });
    const userId = (await signup.json()).user.id as string;
    userIds.push(userId);
    const response = await finish(provider, await start(provider));
    expect(response.headers.get('location')).toContain('error=');
    expect(
      await db.query.authAccounts.findFirst({
        where: eq(authAccounts.accountId, subject),
      }),
    ).toBeUndefined();
  },
);

it('preserves new Microsoft sign-up with userinfo preferred_username and no email verification claim', async () => {
  const response = await finish(
    'microsoft-entra-id',
    await start('microsoft-entra-id'),
  );
  expect(response.headers.get('location')).toBe('/settings/personal');
  const session = await (
    await request('get-session', undefined, cookies(response))
  ).json();
  userIds.push(session.user.id);
  expect(session.user).toMatchObject({
    email: `${subject}@example.test`,
    name: 'Microsoft Fixture',
    emailVerified: false,
  });
});

it.each([
  { aud: 'different-client' },
  { iss: 'https://other-issuer.example.test' },
  { exp: 1 },
  { nonce: 'different-flow' },
])(
  'retains upstream Microsoft ID token validation for invalid fixture claims %j',
  async (claims) => {
    extraClaims = claims;
    await existingUser('microsoft-entra-id');
    const response = await finish(
      'microsoft-entra-id',
      await start('microsoft-entra-id'),
    );
    expect(response.headers.get('location')).toContain('error=');
    expect(
      await (await request('get-session', undefined, cookies(response))).json(),
    ).toBeNull();
  },
);

it('completes a legacy Microsoft form POST callback', async () => {
  const user = await existingUser('microsoft-entra-id');
  const started = await start('microsoft-entra-id');
  const response = await finish('microsoft-entra-id', started, true);
  const completed = await handleAuthRequest(
    new Request(
      new URL(response.headers.get('location')!, 'https://auth.example.test'),
      { headers: { cookie: cookies(started.response) } },
    ),
  );
  expect(completed.headers.get('location')).toBe('/settings/personal');
  expect(
    (await (await request('get-session', undefined, cookies(completed))).json())
      .user.id,
  ).toBe(user.id);
});

it.each(['organizations', 'consumers'])(
  'retains Microsoft account-class restrictions for %s',
  async (tenant) => {
    const config = await resolveAuthProviderConfig();
    vi.mocked(resolveAuthProviderConfig).mockResolvedValue({
      ...config,
      signature: crypto.randomUUID(),
      microsoftTenantId: tenant,
    });
    tenantClaim = tenant === 'organizations' ? CONSUMER : TENANT;
    await existingUser('microsoft-entra-id');
    const response = await finish(
      'microsoft-entra-id',
      await start('microsoft-entra-id'),
    );
    expect(response.headers.get('location')).toContain('error=');
  },
);

const {
  mockDbSelect,
  mockDbUpdate,
  mockEnvState,
  mockProviderConfig,
  mockInviteState,
  mockSetupBootstrapState,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockEnvState: {
    R_ALLOWED_EMAILS: undefined as string | undefined,
    SETUP_TOKEN: undefined as string | undefined,
  },
  mockProviderConfig: {
    current: {
      slackClientId: null as string | null,
      slackClientSecret: null as string | null,
      microsoftClientId: null as string | null,
      microsoftClientSecret: null as string | null,
      microsoftTenantId: null as string | null,
    },
  },
  mockInviteState: {
    requestToken: null as string | null,
    usableInvite: null as { id: string } | null,
  },
  mockSetupBootstrapState: {
    open: true,
  },
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  authAccounts: { providerId: 'provider_id', idToken: 'id_token' },
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
    insert: vi.fn(),
  },
  deploymentSettings: {
    id: 'deployment_settings.id',
    accessPolicy: 'deployment_settings.access_policy',
  },
  eq: vi.fn(),
  isNull: vi.fn(),
  ne: vi.fn(),
  not: vi.fn(),
  slackInstallations: { teamId: 'team_id', isActive: 'is_active' },
  users: { id: 'users.id' },
}));

vi.mock('../env', () => ({
  Env: new Proxy(
    {},
    {
      get: (_target, prop) => mockEnvState[prop as keyof typeof mockEnvState],
    },
  ),
}));

vi.mock('../auth-provider-config', () => ({
  resolveAuthProviderConfig: vi.fn(async () => mockProviderConfig.current),
}));

vi.mock('../invite-context', () => ({
  getRequestInviteToken: vi.fn(async () => mockInviteState.requestToken),
}));

vi.mock('../invites', () => ({
  findUsableInviteByToken: vi.fn(async (token: string | null | undefined) =>
    token ? mockInviteState.usableInvite : null,
  ),
  isSystemInviteToken: vi.fn(
    (token: string | null | undefined) =>
      mockEnvState.SETUP_TOKEN != null && token === mockEnvState.SETUP_TOKEN,
  ),
}));

vi.mock('../setup-bootstrap', () => ({
  isSetupBootstrapOpen: vi.fn(async () => mockSetupBootstrapState.open),
}));

import {
  canVisitorSignUp,
  evaluateSignInAccess,
  getSlackTeamIdFromIdToken,
  isNewAuthUserEmailAllowed,
} from '../access-policy';

function fakeJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

  return `header.${payload}.signature`;
}

// Serves every select shape in the module: .from().limit(), awaited
// .from().where(), and .from().where().limit().
function queueSelect(result: unknown) {
  const limit = vi.fn(async () => result);
  mockDbSelect.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => Object.assign(Promise.resolve(result), { limit })),
      limit,
    })),
  });
}

const queueWhereSelect = queueSelect;
const queueWhereLimitSelect = queueSelect;

afterEach(() => {
  vi.unstubAllEnvs();
});

function resetMocks() {
  vi.clearAllMocks();
  mockDbSelect.mockReset();
  // Default to local development so tokenless bootstrap is permitted unless a
  // test explicitly simulates a non-local deployment.
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('APP_ENV', 'development');
  mockEnvState.R_ALLOWED_EMAILS = undefined;
  mockEnvState.SETUP_TOKEN = undefined;
  mockInviteState.requestToken = null;
  mockInviteState.usableInvite = null;
  mockSetupBootstrapState.open = true;
  mockProviderConfig.current = {
    slackClientId: null,
    slackClientSecret: null,
    microsoftClientId: null,
    microsoftClientSecret: null,
    microsoftTenantId: null,
  };
}

describe('getSlackTeamIdFromIdToken', () => {
  it('reads the slack team claim and tolerates garbage', () => {
    expect(
      getSlackTeamIdFromIdToken(
        fakeJwt({ 'https://slack.com/team_id': 'T123' }),
      ),
    ).toBe('T123');
    expect(getSlackTeamIdFromIdToken(null)).toBeNull();
    expect(getSlackTeamIdFromIdToken('not-a-jwt')).toBeNull();
    expect(getSlackTeamIdFromIdToken(fakeJwt({}))).toBeNull();
  });
});

describe('evaluateSignInAccess', () => {
  beforeEach(resetMocks);

  it('denies when the env allowlist rejects the email', async () => {
    mockEnvState.R_ALLOWED_EMAILS = 'only@example.com';

    await expect(
      evaluateSignInAccess({ userId: 'user-1', email: 'other@example.com' }),
    ).resolves.toEqual({ allowed: false });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('admits existing members', async () => {
    queueWhereLimitSelect([{ id: 'other-user' }]); // hasAnyOtherRealAppUser
    queueWhereLimitSelect([{ id: 'user-1' }]); // hasExistingAppUser

    await expect(
      evaluateSignInAccess({ userId: 'user-1', email: 'member@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'existing_user' });
  });

  it('admits slack users from the anchored workspace', async () => {
    queueWhereLimitSelect([{ id: 'founding-user' }]); // hasAnyOtherRealAppUser
    queueWhereLimitSelect([]); // hasExistingAppUser -> none
    queueWhereSelect([
      {
        providerId: 'slack',
        idToken: fakeJwt({ 'https://slack.com/team_id': 'T123' }),
      },
    ]); // accounts
    queueWhereLimitSelect([{ accessPolicy: { slackTeamId: 'T123' } }]); // policy

    await expect(
      evaluateSignInAccess({ userId: 'user-2', email: 'team@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'org_membership' });
  });

  it('admits microsoft users because the tenant is enforced at OAuth', async () => {
    queueWhereLimitSelect([{ id: 'founding-user' }]); // hasAnyOtherRealAppUser
    queueWhereLimitSelect([]); // hasExistingAppUser
    queueWhereSelect([
      { providerId: 'microsoft-entra-id', idToken: fakeJwt({ tid: 't' }) },
    ]); // accounts
    queueWhereLimitSelect([{ accessPolicy: null }]); // policy

    await expect(
      evaluateSignInAccess({ userId: 'user-2', email: 'team@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'org_membership' });
  });

  it('treats a setup-token Microsoft sign-in as bootstrap before org membership', async () => {
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'setup-secret';
    mockSetupBootstrapState.open = true;

    await expect(
      evaluateSignInAccess({ userId: 'user-2', email: 'admin@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'bootstrap' });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('admits invite holders and reports the invite id', async () => {
    mockInviteState.requestToken = 'invite-token';
    mockInviteState.usableInvite = { id: 'invite-1' };

    queueWhereLimitSelect([{ id: 'founding-user' }]); // hasAnyOtherRealAppUser
    queueWhereLimitSelect([]); // hasExistingAppUser

    await expect(
      evaluateSignInAccess({ userId: 'user-3', email: 'new@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'invite', inviteId: 'invite-1' });
  });

  it('treats the setup token as the system invite while setup is open', async () => {
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'setup-secret';

    queueWhereLimitSelect([]); // hasExistingAppUser
    queueWhereSelect([]); // accounts

    await expect(
      evaluateSignInAccess({ userId: 'user-1', email: 'admin@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'bootstrap' });
  });

  it('re-admits the setup-token holder while setup is open even after an earlier account was created', async () => {
    // An aborted first attempt can leave a user row behind while
    // setupCompletedAt is still null; the operator token must keep working.
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'setup-secret';
    mockSetupBootstrapState.open = true;

    queueWhereLimitSelect([]); // hasExistingAppUser -> this auth user is new
    queueWhereSelect([]); // accounts

    await expect(
      evaluateSignInAccess({ userId: 'user-2', email: 'admin@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'bootstrap' });
  });

  it('denies the setup-token holder once setup is complete', async () => {
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'setup-secret';
    mockSetupBootstrapState.open = false;

    queueWhereLimitSelect([]); // hasExistingAppUser
    queueWhereSelect([]); // accounts

    await expect(
      evaluateSignInAccess({ userId: 'user-2', email: 'late@example.com' }),
    ).resolves.toEqual({ allowed: false });
  });

  it('denies the first sign-in without the setup token when one is required', async () => {
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'wrong-token';

    queueWhereLimitSelect([]); // hasExistingAppUser
    queueWhereSelect([]); // accounts

    await expect(
      evaluateSignInAccess({ userId: 'user-1', email: 'admin@example.com' }),
    ).resolves.toEqual({ allowed: false });
  });

  it('admits the first sign-in in local development when no setup token is configured', async () => {
    vi.stubEnv('APP_ENV', 'development');
    queueWhereLimitSelect([]); // hasAnyOtherRealAppUser

    await expect(
      evaluateSignInAccess({ userId: 'user-1', email: 'dev@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'bootstrap' });
  });

  it('treats local tokenless Microsoft setup as bootstrap before org membership', async () => {
    vi.stubEnv('APP_ENV', 'development');
    queueWhereLimitSelect([]); // hasAnyOtherRealAppUser

    await expect(
      evaluateSignInAccess({ userId: 'user-2', email: 'admin@example.com' }),
    ).resolves.toEqual({ allowed: true, via: 'bootstrap' });
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('denies the first sign-in on a non-local deployment when no setup token is configured', async () => {
    vi.stubEnv('APP_ENV', 'production');
    queueWhereLimitSelect([]); // hasExistingAppUser
    queueWhereSelect([]); // accounts

    await expect(
      evaluateSignInAccess({ userId: 'user-1', email: 'attacker@example.com' }),
    ).resolves.toEqual({ allowed: false });
  });

  it('fails closed for NODE_ENV=production even when APP_ENV is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', undefined);
    queueWhereLimitSelect([]); // hasExistingAppUser
    queueWhereSelect([]); // accounts

    await expect(
      evaluateSignInAccess({ userId: 'user-1', email: 'attacker@example.com' }),
    ).resolves.toEqual({ allowed: false });
  });

  it('denies strangers once setup is complete', async () => {
    mockSetupBootstrapState.open = false;

    queueWhereLimitSelect([]); // hasExistingAppUser
    queueWhereSelect([]); // accounts

    await expect(
      evaluateSignInAccess({ userId: 'user-9', email: 'nope@example.com' }),
    ).resolves.toEqual({ allowed: false });
  });
});

describe('isNewAuthUserEmailAllowed', () => {
  beforeEach(resetMocks);

  it('admits invite holders', async () => {
    mockInviteState.requestToken = 'invite-token';
    mockInviteState.usableInvite = { id: 'invite-1' };

    await expect(isNewAuthUserEmailAllowed('new@example.com')).resolves.toBe(
      true,
    );
  });

  it('admits the first user with the system invite', async () => {
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'setup-secret';

    await expect(isNewAuthUserEmailAllowed('admin@example.com')).resolves.toBe(
      true,
    );
  });

  it('defers to session checks when an org-scoped provider is configured', async () => {
    mockProviderConfig.current.slackClientId = 'client';
    mockProviderConfig.current.slackClientSecret = 'secret';
    mockSetupBootstrapState.open = false;

    await expect(isNewAuthUserEmailAllowed('team@example.com')).resolves.toBe(
      true,
    );
  });

  it('rejects uninvited email/password sign-up even when an org-scoped provider is configured', async () => {
    mockProviderConfig.current.slackClientId = 'client';
    mockProviderConfig.current.slackClientSecret = 'secret';
    mockSetupBootstrapState.open = false;

    await expect(
      isNewAuthUserEmailAllowed('stranger@example.com', {
        isCredentialSignUp: true,
      }),
    ).resolves.toBe(false);
  });

  it('admits email/password sign-up for invite holders', async () => {
    mockInviteState.requestToken = 'invite-token';
    mockInviteState.usableInvite = { id: 'invite-1' };

    await expect(
      isNewAuthUserEmailAllowed('new@example.com', {
        isCredentialSignUp: true,
      }),
    ).resolves.toBe(true);
  });

  it('rejects strangers with no possible admit path', async () => {
    mockSetupBootstrapState.open = false;

    await expect(
      isNewAuthUserEmailAllowed('stranger@example.com'),
    ).resolves.toBe(false);
  });
});

describe('canVisitorSignUp', () => {
  beforeEach(resetMocks);

  it('is true for invite holders', async () => {
    mockInviteState.requestToken = 'invite-token';
    mockInviteState.usableInvite = { id: 'invite-1' };

    await expect(canVisitorSignUp()).resolves.toBe(true);
  });

  it('is true while setup is open without a setup token in local development', async () => {
    vi.stubEnv('APP_ENV', 'development');

    await expect(canVisitorSignUp()).resolves.toBe(true);
  });

  it('is false on a non-local deployment without a setup token', async () => {
    vi.stubEnv('APP_ENV', 'production');

    await expect(canVisitorSignUp()).resolves.toBe(false);
  });

  it('is false when only NODE_ENV=production is set (APP_ENV unset)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', undefined);

    await expect(canVisitorSignUp()).resolves.toBe(false);
  });

  it('is false while setup is open when the required setup token is not presented', async () => {
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'wrong-token';

    await expect(canVisitorSignUp()).resolves.toBe(false);
  });

  it('is true for setup-token holders while setup is open even when users already exist', async () => {
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'setup-secret';
    mockSetupBootstrapState.open = true;

    await expect(canVisitorSignUp()).resolves.toBe(true);
  });

  it('is false for setup-token holders once setup is complete', async () => {
    mockEnvState.SETUP_TOKEN = 'setup-secret';
    mockInviteState.requestToken = 'setup-secret';
    mockSetupBootstrapState.open = false;

    await expect(canVisitorSignUp()).resolves.toBe(false);
  });

  it('is false for uninvited visitors once setup is complete', async () => {
    mockSetupBootstrapState.open = false;

    await expect(canVisitorSignUp()).resolves.toBe(false);
  });
});

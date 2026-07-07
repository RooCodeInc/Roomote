type FakeUser = {
  id: string;
  email?: string;
  role: 'admin' | 'member';
  deletedAt: Date | null;
};

const { state } = vi.hoisted(() => ({
  state: {
    target: undefined as FakeUser | undefined,
    otherAdminExists: false,
    lockTaken: 0,
    updates: [] as Record<string, unknown>[],
    authUserDeletes: 0,
    linkedAccountDeletes: 0,
    credentialAccountExists: false,
    capturedResetUrl:
      'https://roomote.example.com/api/auth/reset-password/token',
    requestedPasswordReset: undefined as
      | { email: string; redirectTo: string }
      | undefined,
  },
}));

vi.mock('../auth', () => ({
  PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS: 3600,
  capturePasswordResetLink: async (callback: () => Promise<void>) => {
    await callback();
    return state.capturedResetUrl;
  },
  getAuth: async () => ({
    api: {
      requestPasswordReset: async (input: {
        body: { email: string; redirectTo: string };
      }) => {
        state.requestedPasswordReset = input.body;
      },
    },
  }),
}));

vi.mock('../env', () => ({
  Env: {
    ROOMOTE_APP_URL: 'https://roomote.example.com',
    ROOMOTE_PUBLIC_URL: undefined,
  },
}));

vi.mock('@roomote/db/server', () => {
  const selectBuilder = {
    from: () => selectBuilder,
    where: () => selectBuilder,
    // The deployment_settings mutex; resolves like an awaited row set.
    for: async () => {
      state.lockTaken += 1;
      return [{ id: 'default' }];
    },
    // The "another active admin" probe.
    limit: async () => (state.otherAdminExists ? [{ id: 'other-admin' }] : []),
  };

  const tx = {
    select: () => selectBuilder,
    query: {
      users: {
        findFirst: async () =>
          state.target && state.target.deletedAt == null
            ? {
                email: 'user@example.com',
                ...state.target,
              }
            : undefined,
      },
      authAccounts: {
        findFirst: async () =>
          state.credentialAccountExists ? { id: 'credential-account' } : null,
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(values);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === authUsersTable) {
          state.authUserDeletes += 1;
          return;
        }

        state.linkedAccountDeletes += 1;
      },
    }),
  };

  const authUsersTable = {};
  const slackUserMappingsTable = {};
  const telegramUserMappingsTable = {};

  return {
    and: vi.fn(),
    authUsers: authUsersTable,
    authAccounts: {},
    db: {
      transaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx),
      query: tx.query,
    },
    deploymentSettings: {},
    eq: vi.fn(),
    isNull: vi.fn(),
    ne: vi.fn(),
    slackUserMappings: slackUserMappingsTable,
    telegramUserMappings: telegramUserMappingsTable,
    users: {},
  };
});

import {
  createPasswordResetLinkForUser,
  removeUser,
  updateUserRole,
  userHasCredentialAccount,
} from '../user-management';

beforeEach(() => {
  vi.useRealTimers();
  state.target = undefined;
  state.otherAdminExists = false;
  state.lockTaken = 0;
  state.updates = [];
  state.authUserDeletes = 0;
  state.linkedAccountDeletes = 0;
  state.credentialAccountExists = false;
  state.capturedResetUrl =
    'https://roomote.example.com/api/auth/reset-password/token';
  state.requestedPasswordReset = undefined;
});

describe('updateUserRole', () => {
  it('refuses to change your own role', async () => {
    const result = await updateUserRole({
      actorUserId: 'user-1',
      targetUserId: 'user-1',
      role: 'member',
    });

    expect(result).toEqual({ updated: false, reason: 'own_role' });
    expect(state.lockTaken).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it('reports missing or removed users as not found', async () => {
    const result = await updateUserRole({
      actorUserId: 'admin-1',
      targetUserId: 'ghost',
      role: 'admin',
    });

    expect(result).toEqual({ updated: false, reason: 'not_found' });
    expect(state.updates).toHaveLength(0);
  });

  it('refuses to demote the last active admin', async () => {
    state.target = { id: 'admin-2', role: 'admin', deletedAt: null };
    state.otherAdminExists = false;

    const result = await updateUserRole({
      actorUserId: 'admin-1',
      targetUserId: 'admin-2',
      role: 'member',
    });

    expect(result).toEqual({ updated: false, reason: 'last_admin' });
    expect(state.updates).toHaveLength(0);
  });

  it('demotes an admin when another active admin remains', async () => {
    state.target = { id: 'admin-2', role: 'admin', deletedAt: null };
    state.otherAdminExists = true;

    const result = await updateUserRole({
      actorUserId: 'admin-1',
      targetUserId: 'admin-2',
      role: 'member',
    });

    expect(result).toEqual({ updated: true });
    expect(state.lockTaken).toBe(1);
    expect(state.updates[0]).toMatchObject({ role: 'member' });
  });

  it('promotes a member without consulting the admin count', async () => {
    state.target = { id: 'member-1', role: 'member', deletedAt: null };

    const result = await updateUserRole({
      actorUserId: 'admin-1',
      targetUserId: 'member-1',
      role: 'admin',
    });

    expect(result).toEqual({ updated: true });
    expect(state.updates[0]).toMatchObject({ role: 'admin' });
  });

  it('treats a same-role change as a no-op success', async () => {
    state.target = { id: 'member-1', role: 'member', deletedAt: null };

    const result = await updateUserRole({
      actorUserId: 'admin-1',
      targetUserId: 'member-1',
      role: 'member',
    });

    expect(result).toEqual({ updated: true });
    expect(state.updates).toHaveLength(0);
  });
});

describe('createPasswordResetLinkForUser', () => {
  it('reports missing or removed users as not found', async () => {
    const result = await createPasswordResetLinkForUser({
      targetUserId: 'ghost',
    });

    expect(result).toEqual({ created: false, reason: 'not_found' });
    expect(state.requestedPasswordReset).toBeUndefined();
  });

  it('refuses OAuth-only users', async () => {
    state.target = {
      id: 'user-1',
      email: 'ada@example.com',
      role: 'member',
      deletedAt: null,
    };
    state.credentialAccountExists = false;

    const result = await createPasswordResetLinkForUser({
      targetUserId: 'user-1',
    });

    expect(result).toEqual({ created: false, reason: 'oauth_only' });
    expect(state.requestedPasswordReset).toBeUndefined();
  });

  it('creates a BetterAuth password reset link for credential users', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T12:00:00Z'));
    state.target = {
      id: 'user-1',
      email: 'ada@example.com',
      role: 'member',
      deletedAt: null,
    };
    state.credentialAccountExists = true;

    const result = await createPasswordResetLinkForUser({
      targetUserId: 'user-1',
    });

    expect(result).toEqual({
      created: true,
      url: 'https://roomote.example.com/api/auth/reset-password/token',
      expiresAt: new Date('2026-07-03T13:00:00Z'),
    });
    expect(state.requestedPasswordReset).toEqual({
      email: 'ada@example.com',
      redirectTo: 'https://roomote.example.com/reset-password',
    });
  });

  it('reports when BetterAuth does not generate a link', async () => {
    state.target = {
      id: 'user-1',
      email: 'ada@example.com',
      role: 'member',
      deletedAt: null,
    };
    state.credentialAccountExists = true;
    state.capturedResetUrl = '';

    const result = await createPasswordResetLinkForUser({
      targetUserId: 'user-1',
    });

    expect(result).toEqual({ created: false, reason: 'not_generated' });
  });
});

describe('userHasCredentialAccount', () => {
  it('returns whether the user has a credential account', async () => {
    state.credentialAccountExists = true;
    await expect(userHasCredentialAccount('user-1')).resolves.toBe(true);

    state.credentialAccountExists = false;
    await expect(userHasCredentialAccount('user-1')).resolves.toBe(false);
  });
});

describe('removeUser', () => {
  it('refuses to remove yourself', async () => {
    const result = await removeUser({
      actorUserId: 'user-1',
      targetUserId: 'user-1',
    });

    expect(result).toEqual({ removed: false, reason: 'own_account' });
    expect(state.lockTaken).toBe(0);
    expect(state.updates).toHaveLength(0);
    expect(state.authUserDeletes).toBe(0);
    expect(state.linkedAccountDeletes).toBe(0);
  });

  it('reports missing or already-removed users as not found', async () => {
    const result = await removeUser({
      actorUserId: 'admin-1',
      targetUserId: 'ghost',
    });

    expect(result).toEqual({ removed: false, reason: 'not_found' });
    expect(state.updates).toHaveLength(0);
    expect(state.authUserDeletes).toBe(0);
    expect(state.linkedAccountDeletes).toBe(0);
  });

  it('refuses to remove the last active admin', async () => {
    state.target = { id: 'admin-2', role: 'admin', deletedAt: null };
    state.otherAdminExists = false;

    const result = await removeUser({
      actorUserId: 'admin-1',
      targetUserId: 'admin-2',
    });

    expect(result).toEqual({ removed: false, reason: 'last_admin' });
    expect(state.updates).toHaveLength(0);
    expect(state.authUserDeletes).toBe(0);
    expect(state.linkedAccountDeletes).toBe(0);
  });

  it('removes an admin when another active admin remains', async () => {
    state.target = { id: 'admin-2', role: 'admin', deletedAt: null };
    state.otherAdminExists = true;

    const result = await removeUser({
      actorUserId: 'admin-1',
      targetUserId: 'admin-2',
    });

    expect(result).toEqual({ removed: true });
    expect(state.updates[0]).toHaveProperty('deletedAt');
    expect(state.authUserDeletes).toBe(1);
    expect(state.linkedAccountDeletes).toBe(2);
  });

  it('soft-deletes the app user and deletes the auth user for members', async () => {
    state.target = { id: 'member-1', role: 'member', deletedAt: null };

    const result = await removeUser({
      actorUserId: 'admin-1',
      targetUserId: 'member-1',
    });

    expect(result).toEqual({ removed: true });
    expect(state.lockTaken).toBe(1);
    expect(state.updates[0]).toHaveProperty('deletedAt');
    expect(state.authUserDeletes).toBe(1);
    expect(state.linkedAccountDeletes).toBe(2);
  });
});

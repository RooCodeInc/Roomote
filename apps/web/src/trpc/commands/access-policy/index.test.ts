type TestUser = {
  id: string;
  name: string;
  email: string;
  imageUrl: string;
  role: 'admin' | 'member';
  createdAt: Date;
};

const { state } = vi.hoisted(() => ({
  state: {
    users: [] as TestUser[],
    credentialUserIds: [] as string[],
    createdResetLinkForUserId: null as string | null,
  },
}));

vi.mock('@roomote/db/server', () => {
  const users = {};
  const authAccounts = {};

  return {
    and: vi.fn(),
    authAccounts,
    deploymentSettings: { id: 'deployment_settings.id' },
    db: {
      select: () => {
        let selectedTable: unknown;
        return {
          from: (table: unknown) => {
            selectedTable = table;
            return {
              where: () => {
                if (selectedTable === authAccounts) {
                  return state.credentialUserIds.map((userId) => ({ userId }));
                }
                return {
                  orderBy: async () => state.users,
                };
              },
            };
          },
        };
      },
    },
    eq: vi.fn(),
    inArray: vi.fn(),
    isNull: vi.fn(),
    users,
  };
});

vi.mock('@/lib/server', () => ({
  buildInviteUrl: vi.fn(),
  createInvite: vi.fn(),
  createPasswordResetLinkForUser: vi.fn(
    async ({ targetUserId }: { targetUserId: string }) => {
      state.createdResetLinkForUserId = targetUserId;
      return {
        created: true,
        url: 'https://roomote.example.com/api/auth/reset-password/token',
        expiresAt: new Date('2026-07-03T13:00:00Z'),
      };
    },
  ),
  FREE_SEAT_LIMIT: 10,
  getDeploymentAccessPolicy: vi.fn(async () => null),
  getDeploymentLicenseState: vi.fn(async () => ({
    status: 'unlicensed',
    seatLimit: 10,
  })),
  isInviteUsable: vi.fn(() => true),
  listInvites: vi.fn(async () => []),
  removeUser: vi.fn(),
  resolveLicenseState: vi.fn(() => ({ status: 'unlicensed', seatLimit: 10 })),
  revokeInvite: vi.fn(),
  updateUserRole: vi.fn(),
}));

vi.mock('@/lib/server/env', () => ({
  Env: {
    ROOMOTE_APP_URL: 'https://roomote.example.com',
    ROOMOTE_PUBLIC_URL: undefined,
  },
}));

vi.mock('@/lib/server/auth-provider-config', () => ({
  resolveAuthProviderConfig: vi.fn(async () => ({
    slackClientId: null,
    slackClientSecret: null,
    microsoftClientId: null,
    microsoftClientSecret: null,
    microsoftTenantId: null,
  })),
}));

import {
  createPasswordResetLinkCommand,
  getAccessPolicySettingsCommand,
} from './index';

describe('access policy commands', () => {
  beforeEach(() => {
    state.users = [];
    state.credentialUserIds = [];
    state.createdResetLinkForUserId = null;
  });

  it('marks active users that have credential accounts', async () => {
    state.users = [
      {
        id: 'user-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        imageUrl: '',
        role: 'admin',
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
      {
        id: 'user-2',
        name: 'Grace Hopper',
        email: 'grace@example.com',
        imageUrl: '',
        role: 'member',
        createdAt: new Date('2026-07-02T00:00:00Z'),
      },
    ];
    state.credentialUserIds = ['user-2'];

    const result = await getAccessPolicySettingsCommand({
      isAdmin: true,
    } as never);

    expect(result.users).toEqual([
      expect.objectContaining({
        id: 'user-1',
        hasCredentialAccount: false,
      }),
      expect.objectContaining({
        id: 'user-2',
        hasCredentialAccount: true,
      }),
    ]);
  });

  it('rejects password reset link creation for non-admins', async () => {
    await expect(
      createPasswordResetLinkCommand({ isAdmin: false } as never, {
        userId: 'user-1',
      }),
    ).rejects.toThrow('Unauthorized');
    expect(state.createdResetLinkForUserId).toBeNull();
  });

  it('returns generated password reset links for admins', async () => {
    const result = await createPasswordResetLinkCommand(
      { isAdmin: true } as never,
      { userId: 'user-1' },
    );

    expect(result).toEqual({
      url: 'https://roomote.example.com/api/auth/reset-password/token',
      expiresAt: new Date('2026-07-03T13:00:00Z'),
    });
    expect(state.createdResetLinkForUserId).toBe('user-1');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'better-auth/api';

const {
  mockDeploymentFindFirst,
  mockUsersFindFirst,
  mockInsertValues,
  mockUpdateSet,
  mockUpdateWhere,
  mockGetSession,
  mockAccessDecision,
  mockTxState,
} = vi.hoisted(() => ({
  mockDeploymentFindFirst: vi.fn(),
  mockUsersFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockGetSession: vi.fn(),
  mockAccessDecision: {
    current: { allowed: true, via: 'existing_user' } as {
      allowed: boolean;
      via?: string;
      inviteId?: string;
    },
  },
  mockTxState: {
    anyUser: null as { id: string } | null,
    insertedValues: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@roomote/sdk/server/request-instance-ping', () => ({
  requestInstancePing: vi.fn(async () => undefined),
  requestLicenseUsageSync: vi.fn(async () => undefined),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

vi.mock('@roomote/db/server', () => ({
  recordLicenseUsageObservation: vi.fn(async () => undefined),
  db: {
    query: {
      deploymentSettings: {
        findFirst: (...args: unknown[]) => mockDeploymentFindFirst(...args),
      },
      users: {
        findFirst: (...args: unknown[]) => mockUsersFindFirst(...args),
      },
    },
    insert: vi.fn(() => ({
      values: (...args: unknown[]) => mockInsertValues(...args),
    })),
    update: vi.fn(() => ({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);

        return {
          where: (...whereArgs: unknown[]) => mockUpdateWhere(...whereArgs),
        };
      },
    })),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            limit: vi.fn(async () =>
              mockTxState.anyUser ? [mockTxState.anyUser] : [],
            ),
          })),
        })),
        insert: vi.fn(() => ({
          values: (values: Record<string, unknown>) => {
            mockTxState.insertedValues.push(values);

            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(async () => [{ id: values.id }]),
              })),
            };
          },
        })),
        query: {
          invites: {
            findFirst: vi.fn(async () => null),
          },
        },
      };

      return callback(tx);
    },
  },
  deploymentSettings: { id: 'deployment_settings.id' },
  invites: { id: 'invites.id' },
  users: { id: 'users.id' },
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
}));

vi.mock('./bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: vi.fn(),
}));

vi.mock('./env', () => ({
  Env: {
    R_ALLOWED_EMAILS: '',
  },
  isRoomoteCloudEnabled: () => false,
}));

vi.mock('./sentry-context', () => ({
  setSentryUserContext: vi.fn(),
}));

vi.mock('./auth', () => ({
  getAuth: vi.fn(async () => ({
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  })),
}));

vi.mock('./access-policy', () => ({
  evaluateSignInAccess: vi.fn(async () => mockAccessDecision.current),
  seedDeploymentAccessPolicyIfNeeded: vi.fn(async () => undefined),
}));

vi.mock('./invites', () => ({
  InviteRedemptionFailedError: class InviteRedemptionFailedError extends Error {},
  redeemInvite: vi.fn(async () => true),
}));

vi.mock('./license', () => ({
  SeatLimitExceededError: class SeatLimitExceededError extends Error {},
  assertSeatAvailable: vi.fn(async () => undefined),
}));

import { authorize } from './auth-context';

describe('authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessDecision.current = { allowed: true, via: 'existing_user' };
    mockTxState.anyUser = null;
    mockTxState.insertedValues = [];
    mockGetSession.mockResolvedValue({
      user: {
        id: 'user-1',
        name: 'Jane Admin',
        email: 'jane@example.com',
        image: 'https://example.com/avatar.png',
      },
    });
    mockDeploymentFindFirst.mockResolvedValue({ metadata: {} });
    mockUsersFindFirst.mockResolvedValue({
      id: 'user-1',
      name: 'Jane Admin',
      email: 'jane@example.com',
      entity: {
        id: 'user-1',
        name: 'Jane Admin',
        email: 'jane@example.com',
        imageUrl: 'https://example.com/avatar.png',
      },
      role: 'admin',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      imageUrl: 'https://example.com/avatar.png',
      onboardingCompletedAt: new Date('2025-01-01T00:00:00.000Z'),
      deletedAt: null,
    });
    mockUpdateWhere.mockResolvedValue([]);
  });

  it('exposes an existing cookie acceptance timestamp', async () => {
    mockUsersFindFirst.mockResolvedValue({
      id: 'user-1',
      name: 'Jane Admin',
      email: 'jane@example.com',
      entity: {
        id: 'user-1',
        name: 'Jane Admin',
        email: 'jane@example.com',
        imageUrl: 'https://example.com/avatar.png',
      },
      role: 'admin',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      imageUrl: 'https://example.com/avatar.png',
      onboardingCompletedAt: new Date('2025-01-01T00:00:00.000Z'),
      cookieConsentedAt: new Date('2026-07-30T12:00:00.000Z'),
      deletedAt: null,
    });

    const result = await authorize();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.cookieConsentedAt).toBe(
        new Date('2026-07-30T12:00:00.000Z').getTime(),
      );
    }
  });

  it('does not write an unchanged existing user during authorization', async () => {
    const result = await authorize();

    expect(result.success).toBe(true);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('hydrates an empty feature flag map from stale deployment metadata', async () => {
    mockDeploymentFindFirst.mockResolvedValue({
      metadata: { suggestion_routing: true },
    });

    const result = await authorize();

    expect(result.success).toBe(true);
    if (result.success) expect(result.featureFlags).toEqual({});
  });

  it('keeps an unchanged member with incomplete onboarding read-only', async () => {
    mockUsersFindFirst.mockResolvedValue({
      id: 'user-1',
      name: 'Jane Admin',
      email: 'jane@example.com',
      entity: {
        id: 'user-1',
        name: 'Jane Admin',
        email: 'jane@example.com',
        imageUrl: 'https://example.com/avatar.png',
      },
      role: 'member',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      imageUrl: 'https://example.com/avatar.png',
      onboardingCompletedAt: null,
      deletedAt: null,
    });

    const result = await authorize();

    expect(result.success).toBe(true);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('syncs an existing user when their auth profile changes', async () => {
    mockUsersFindFirst.mockResolvedValue({
      id: 'user-1',
      name: 'Old Name',
      email: 'jane@example.com',
      entity: {
        id: 'user-1',
        name: 'Old Name',
        email: 'jane@example.com',
        imageUrl: 'https://example.com/avatar.png',
      },
      role: 'admin',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      imageUrl: 'https://example.com/avatar.png',
      onboardingCompletedAt: new Date('2025-01-01T00:00:00.000Z'),
      deletedAt: null,
    });

    const result = await authorize();

    expect(result.success).toBe(true);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Jane Admin',
        entity: expect.objectContaining({ name: 'Jane Admin' }),
      }),
    );
  });

  it('treats invalid auth cookies as signed out instead of throwing', async () => {
    mockGetSession.mockRejectedValue(
      new APIError('UNAUTHORIZED', {
        message: 'Invalid session',
      }),
    );

    await expect(authorize()).resolves.toEqual({
      success: false,
      error: 'Unauthorized: User required',
    });
  });

  it('does not hide auth service failures as signed-out sessions', async () => {
    const error = new APIError('INTERNAL_SERVER_ERROR', {
      message: 'Session store unavailable',
    });
    mockGetSession.mockRejectedValue(error);

    await expect(authorize()).rejects.toBe(error);
  });

  it('admits a bootstrap sign-in as admin even when another user already exists', async () => {
    // An aborted earlier attempt can leave a real account behind, so the
    // setup-token holder must still come back in as an operator, not a member.
    mockAccessDecision.current = { allowed: true, via: 'bootstrap' };
    mockUsersFindFirst.mockResolvedValue(null);
    mockTxState.anyUser = { id: 'aborted-setup-user' };

    const result = await authorize();

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.isAdmin).toBe(true);
    expect(mockTxState.insertedValues).toEqual([
      expect.objectContaining({ id: 'user-1', role: 'admin' }),
    ]);
  });

  it('promotes an existing member admitted by the setup token while setup is open', async () => {
    mockAccessDecision.current = { allowed: true, via: 'bootstrap' };
    mockUsersFindFirst.mockResolvedValue({
      id: 'user-1',
      role: 'member',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      imageUrl: 'https://example.com/avatar.png',
      onboardingCompletedAt: new Date('2025-01-01T00:00:00.000Z'),
      deletedAt: null,
    });

    const result = await authorize();

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.isAdmin).toBe(true);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
    );
  });

  it('admits non-bootstrap newcomers as members when users already exist', async () => {
    mockAccessDecision.current = { allowed: true, via: 'org_membership' };
    mockUsersFindFirst.mockResolvedValue(null);
    mockTxState.anyUser = { id: 'earlier-user' };

    const result = await authorize();

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.isAdmin).toBe(false);
    expect(mockTxState.insertedValues).toEqual([
      expect.objectContaining({ id: 'user-1', role: 'member' }),
    ]);
  });
});

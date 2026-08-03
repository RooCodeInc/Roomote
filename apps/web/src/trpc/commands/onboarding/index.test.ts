import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSubscribe, mockWhere } = vi.hoisted(() => ({
  mockSubscribe: vi.fn(),
  mockWhere: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    update: () => ({
      set: () => ({ where: mockWhere }),
    }),
  },
  users: {
    id: 'users.id',
    onboardingCompletedAt: 'users.onboardingCompletedAt',
  },
  eq: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  resolveConfiguredGitHubAppSlug: vi.fn(),
}));

vi.mock('@roomote/types', () => ({
  MCP_INTEGRATIONS: [],
  isDeploymentScopedMcpIntegration: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  LINEAR_ORG_CONNECTION_ROLE: 'org',
  LINEAR_USER_CONNECTION_ROLE: 'user',
}));

vi.mock('../linked-accounts', () => ({
  getLinkedAdoAccountCommand: vi.fn(),
  getLinkedBitbucketAccountCommand: vi.fn(),
  getLinkedDiscordAccountCommand: vi.fn(),
  getLinkedGitLabAccountCommand: vi.fn(),
  getLinkedGiteaAccountCommand: vi.fn(),
  getLinkedMicrosoftTeamsAccountCommand: vi.fn(),
  getLinkedTelegramAccountCommand: vi.fn(),
}));

vi.mock('@/lib/server/product-updates', () => ({
  subscribeToProductUpdates: (...args: unknown[]) => mockSubscribe(...args),
}));

import type { UserAuthSuccess } from '@/types';
import { completeOnboardingCommand } from './index';

function buildAuth(overrides: Partial<UserAuthSuccess> = {}): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'user-1',
    name: 'User',
    primaryEmail: 'user@example.com',
    isAdmin: false,
    anonymousAnalyticsEnabled: false,
    cloudEnabled: false,
    resource: {
      username: null,
      fullName: null,
      firstName: null,
      lastName: null,
      primaryEmailAddress: null,
      emailAddresses: [],
      imageUrl: '',
      createdAt: null,
    },
    ...overrides,
  } as UserAuthSuccess;
}

describe('completeOnboardingCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes by default with the onboarding source', async () => {
    await completeOnboardingCommand(buildAuth());

    expect(mockSubscribe).toHaveBeenCalledWith(
      'user@example.com',
      'onboarding',
    );
  });

  it('does not subscribe after an explicit opt-out', async () => {
    await completeOnboardingCommand(buildAuth(), {
      productUpdatesEnabled: false,
    });

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('excludes Cloud admins but retains Cloud non-admin eligibility', async () => {
    await completeOnboardingCommand(
      buildAuth({ cloudEnabled: true, isAdmin: true }),
    );
    await completeOnboardingCommand(
      buildAuth({ cloudEnabled: true, isAdmin: false }),
    );

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledWith(
      'user@example.com',
      'onboarding',
    );
  });
});

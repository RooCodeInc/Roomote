import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';
import { mockFeatureFlags, mockUserResource } from '@/lib/mock-utils';

const {
  mockFindFirst,
  mockInsertValues,
  mockUpdateSetWhere,
  mockInvalidateDeploymentCache,
  mockGetRedis,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateSetWhere: vi.fn(),
  mockInvalidateDeploymentCache: vi.fn(),
  mockGetRedis: vi.fn(() => ({ __redis: true })),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      deploymentSettings: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    insert: vi.fn(() => ({
      values: (...args: unknown[]) => mockInsertValues(...args),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: (...args: unknown[]) => mockUpdateSetWhere(...args),
      }),
    })),
  },
  deploymentSettings: { id: 'deployment_settings.id' },
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => mockGetRedis(),
}));

vi.mock('@roomote/feature-flags/server', () => ({
  getFeatureFlagEvaluator: () => ({
    invalidateDeploymentCache: (...args: unknown[]) =>
      mockInvalidateDeploymentCache(...args),
  }),
}));

import {
  getExperimentalFlagsCommand,
  updateExperimentalFlagCommand,
} from './index';

function buildAuth(isAdmin: boolean): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'user-1',
    name: 'Jane Admin',
    primaryEmail: 'jane@example.com',
    isAdmin,
    featureFlags: mockFeatureFlags,
    anonymousAnalyticsEnabled: false,
    cloudEnabled: false,
    cookieConsentedAt: null,
    resource: mockUserResource,
  };
}

describe('feature-flags commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getExperimentalFlagsCommand rejects non-admins', async () => {
    await expect(getExperimentalFlagsCommand(buildAuth(false))).rejects.toThrow(
      'Unauthorized',
    );
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('getExperimentalFlagsCommand returns every configured flag', async () => {
    mockFindFirst.mockResolvedValue({ metadata: {} });

    const flags = await getExperimentalFlagsCommand(buildAuth(true));

    expect(flags).toHaveLength(Object.keys(FeatureFlag).length);
    expect(flags[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        metadataKey: expect.any(String),
        description: expect.any(String),
        value: expect.any(Boolean),
        explicitlySet: false,
        defaultValue: expect.any(Boolean),
      }),
    );
  });

  it('getExperimentalFlagsCommand reflects explicit metadata overrides', async () => {
    mockFindFirst.mockResolvedValue({
      metadata: { suggestion_routing: true, opencode_code_mode: true },
    });

    const flags = await getExperimentalFlagsCommand(buildAuth(true));
    const suggestionRouting = flags.find(
      (f) => f.id === FeatureFlag.SuggestionRouting,
    );
    const codeMode = flags.find((f) => f.id === FeatureFlag.CodeMode);

    expect(suggestionRouting?.value).toBe(true);
    expect(suggestionRouting?.explicitlySet).toBe(true);
    expect(codeMode?.value).toBe(true);
    expect(codeMode?.explicitlySet).toBe(true);
    expect(codeMode?.metadataKey).toBe('opencode_code_mode');
  });

  it('updateExperimentalFlagCommand rejects non-admins', async () => {
    await expect(
      updateExperimentalFlagCommand(buildAuth(false), {
        flag: FeatureFlag.SuggestionRouting,
        value: true,
      }),
    ).rejects.toThrow('Unauthorized');
    expect(mockInvalidateDeploymentCache).not.toHaveBeenCalled();
  });

  it('updateExperimentalFlagCommand writes the metadata key and invalidates the cache', async () => {
    mockFindFirst.mockResolvedValue({
      metadata: { suggestion_routing: true },
    });
    mockUpdateSetWhere.mockResolvedValue([]);

    const flags = await updateExperimentalFlagCommand(buildAuth(true), {
      flag: FeatureFlag.SuggestionRouting,
      value: true,
    });

    expect(mockUpdateSetWhere).toHaveBeenCalledTimes(1);
    expect(mockInvalidateDeploymentCache).toHaveBeenCalledTimes(1);

    const suggestionRouting = flags.find(
      (f) => f.id === FeatureFlag.SuggestionRouting,
    );
    expect(suggestionRouting?.value).toBe(true);
    expect(suggestionRouting?.explicitlySet).toBe(true);
  });
});

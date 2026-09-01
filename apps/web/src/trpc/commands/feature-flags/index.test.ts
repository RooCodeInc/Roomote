import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserAuthSuccess } from '@/types';
import { mockUserResource } from '@/lib/mock-utils';

const { mockFindFirst, mockInsert, mockUpdate, mockInvalidate } = vi.hoisted(
  () => ({
    mockFindFirst: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockInvalidate: vi.fn(),
  }),
);

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { deploymentSettings: { findFirst: mockFindFirst } },
    insert: mockInsert,
    update: mockUpdate,
  },
  deploymentSettings: { id: 'deployment_settings.id' },
  eq: vi.fn(),
}));
vi.mock('@roomote/redis', () => ({ getRedis: vi.fn() }));
vi.mock('@roomote/feature-flags/server', () => ({
  getFeatureFlagEvaluator: vi.fn(() => ({
    invalidateDeploymentCache: mockInvalidate,
  })),
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
    featureFlags: {},
    anonymousAnalyticsEnabled: false,
    cloudEnabled: false,
    cookieConsentedAt: null,
    resource: mockUserResource,
  };
}

describe('feature-flags commands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the composer suggestions flag, defaulting to disabled', async () => {
    mockFindFirst.mockResolvedValue({ metadata: {} });

    await expect(getExperimentalFlagsCommand(buildAuth(true))).resolves.toEqual(
      [
        expect.objectContaining({
          id: 'composerSuggestions',
          metadataKey: 'composerSuggestions',
          value: false,
          explicitlySet: false,
          defaultValue: false,
        }),
      ],
    );
  });

  it('reflects an explicitly enabled composer suggestions flag', async () => {
    mockFindFirst.mockResolvedValue({
      metadata: { composerSuggestions: true },
    });

    await expect(getExperimentalFlagsCommand(buildAuth(true))).resolves.toEqual(
      [
        expect.objectContaining({
          id: 'composerSuggestions',
          value: true,
          explicitlySet: true,
        }),
      ],
    );
  });

  it('still rejects non-admin reads', async () => {
    await expect(getExperimentalFlagsCommand(buildAuth(false))).rejects.toThrow(
      'Unauthorized',
    );
  });

  it('rejects stale flags before metadata lookup or a database write', async () => {
    await expect(
      updateExperimentalFlagCommand(buildAuth(true), {
        flag: 'SuggestionRouting' as never,
        value: true,
      }),
    ).rejects.toThrow('Unknown feature flag: SuggestionRouting');

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('still rejects non-admins first', async () => {
    await expect(
      updateExperimentalFlagCommand(buildAuth(false), {
        flag: 'SuggestionRouting' as never,
        value: true,
      }),
    ).rejects.toThrow('Unauthorized');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindFirst,
  mockRedisGet,
  mockRedisSet,
  mockFetch,
  mockIsRoomoteCloudEnabled,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockFetch: vi.fn(),
  mockIsRoomoteCloudEnabled: vi.fn((): boolean => false),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      deploymentSettings: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
  },
  deploymentSettings: { id: 'id' },
  eq: (left: unknown, right: unknown) => ({ left, right }),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: mockRedisGet,
    set: mockRedisSet,
  }),
  REDIS_KEYS: { RELEASE_NOTES: 'release:notes' },
  RELEASE_NOTES_CACHE_TTL_SECONDS: 100,
  RELEASE_NOTES_NEGATIVE_CACHE_TTL_SECONDS: 10,
}));

vi.mock('@/lib/server/env', () => ({
  Env: { RELEASE_VERSION: 'v0.14.0', R_CLOUD_ENABLED: false },
  isRoomoteCloudEnabled: () => mockIsRoomoteCloudEnabled(),
}));

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server/env';
import { getReleaseNotesCommand, getReleaseStatusCommand } from './index';

const mockEnv = Env as {
  RELEASE_VERSION?: string;
  RELEASE_PRODUCT_VERSION?: string;
};

const adminAuth = {
  success: true,
  userType: 'user',
  userId: 'admin-1',
  name: 'Admin',
  primaryEmail: 'admin@example.com',
  isAdmin: true,
  anonymousAnalyticsEnabled: true,
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
} as unknown as UserAuthSuccess;

const memberAuth = {
  ...adminAuth,
  userId: 'member-1',
  isAdmin: false,
} as unknown as UserAuthSuccess;

describe('releases commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockEnv.RELEASE_VERSION = 'v0.14.0';
    delete mockEnv.RELEASE_PRODUCT_VERSION;
    mockIsRoomoteCloudEnabled.mockReturnValue(false);
    mockFindFirst.mockResolvedValue({
      latestKnownVersion: '0.15.0',
      latestVersionCheckedAt: new Date('2026-07-20T00:00:00.000Z'),
    });
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    vi.stubGlobal('fetch', mockFetch);
  });

  it('exposes update status only to self-host admins', async () => {
    await expect(getReleaseStatusCommand(adminAuth)).resolves.toEqual({
      runningVersion: '0.14.0',
      displayVersion: 'v0.14.0',
      latestKnownVersion: '0.15.0',
      latestVersionCheckedAt: '2026-07-20T00:00:00.000Z',
      updateAvailable: true,
    });

    await expect(getReleaseStatusCommand(memberAuth)).resolves.toEqual({
      runningVersion: '0.14.0',
      displayVersion: 'v0.14.0',
      latestKnownVersion: null,
      latestVersionCheckedAt: null,
      updateAvailable: false,
    });

    mockIsRoomoteCloudEnabled.mockReturnValue(true);
    await expect(getReleaseStatusCommand(adminAuth)).resolves.toMatchObject({
      latestKnownVersion: null,
      updateAvailable: false,
    });
  });

  it('uses the commit for display while preserving the baked product version for notices', async () => {
    mockEnv.RELEASE_VERSION = 'main-037146ca';
    mockEnv.RELEASE_PRODUCT_VERSION = '0.14.0';

    await expect(getReleaseStatusCommand(adminAuth)).resolves.toMatchObject({
      runningVersion: '0.14.0',
      displayVersion: '037146ca',
      updateAvailable: true,
    });
  });

  it('reports no update for channel build tags without a product version', async () => {
    mockEnv.RELEASE_VERSION = 'main-037146ca';

    await expect(getReleaseStatusCommand(adminAuth)).resolves.toMatchObject({
      runningVersion: 'main-037146ca',
      displayVersion: '037146ca',
      updateAvailable: false,
    });
  });

  it('uses the GitHub build commit when a branch build has no named version', async () => {
    mockEnv.RELEASE_VERSION = 'main';
    vi.stubEnv('GITHUB_SHA', '037146ca');

    await expect(getReleaseStatusCommand(memberAuth)).resolves.toMatchObject({
      displayVersion: '037146ca',
    });
  });

  it('fetches and caches release notes for the running version', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.14.0',
        name: 'Roomote v0.14.0',
        body: '## 0.14.0\n\nSummary here.\n\n### Highlights\n\n- One\n\n### Minor changes\n\n- Two\n',
        html_url: 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.14.0',
      }),
    });

    const notes = await getReleaseNotesCommand(memberAuth, {
      version: '0.14.0',
    });

    expect(notes).toMatchObject({
      version: '0.14.0',
      summary: 'Summary here.',
      highlights: ['One'],
    });
    expect(mockRedisSet).toHaveBeenCalled();
  });

  it('refuses notes for versions the caller cannot see', async () => {
    await expect(
      getReleaseNotesCommand(memberAuth, { version: '0.15.0' }),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows admins to fetch latest notes and returns null on cache miss + 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    await expect(
      getReleaseNotesCommand(adminAuth, { version: '0.15.0' }),
    ).resolves.toBeNull();
    expect(mockRedisSet).toHaveBeenCalled();
  });
});

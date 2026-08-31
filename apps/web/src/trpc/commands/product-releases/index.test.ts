import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindFirst, mockFetch, mockReadFile, mockIsRoomoteCloudEnabled } =
  vi.hoisted(() => ({
    mockFindFirst: vi.fn(),
    mockFetch: vi.fn(),
    mockReadFile: vi.fn(),
    mockIsRoomoteCloudEnabled: vi.fn((): boolean => false),
  }));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
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

vi.mock('@/lib/server/env', () => ({
  Env: { RELEASE_VERSION: 'v0.14.0', R_CLOUD_ENABLED: false },
  isRoomoteCloudEnabled: () => mockIsRoomoteCloudEnabled(),
}));

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server/env';
import {
  getReleaseHistoryCommand,
  getReleaseNotesCommand,
  getReleaseStatusCommand,
} from './index';

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
    mockReadFile.mockResolvedValue(`# Changelog

## 0.17.0 (2026-07-22)

Not installed yet.

## 0.14.0 (2026-07-19)

Oldest release.

## 0.16.0 (2026-07-21)

Current release.

## 0.15.0 (2026-07-20)

Previous release.
`);
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

  it('reads release notes for the running version from the changelog', async () => {
    const notes = await getReleaseNotesCommand(memberAuth, {
      version: '0.14.0',
    });

    expect(notes).toMatchObject({
      version: '0.14.0',
      summary: 'Oldest release.',
      htmlUrl: 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.14.0',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns changelog release history newest first through the running version', async () => {
    mockEnv.RELEASE_VERSION = 'v0.16.0';

    const releases = await getReleaseHistoryCommand(memberAuth, {
      version: '0.16.0',
    });

    expect(releases.map((release) => release.version)).toEqual([
      '0.16.0',
      '0.15.0',
      '0.14.0',
    ]);
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining('CHANGELOG.md'),
      'utf8',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps a newer update target visible when its notes are absent locally', async () => {
    mockReadFile.mockResolvedValue(`# Changelog

## 0.14.0 (2026-07-19)

Installed release.
`);

    const releases = await getReleaseHistoryCommand(adminAuth, {
      version: '0.15.0',
    });

    expect(releases).toEqual([
      {
        version: '0.15.0',
        tagName: 'v0.15.0',
        title: 'Roomote v0.15.0',
        summary: null,
        highlights: [],
        detailsMarkdown: '',
        htmlUrl: 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.15.0',
      },
      expect.objectContaining({
        version: '0.14.0',
        summary: 'Installed release.',
      }),
    ]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses notes for versions the caller cannot see', async () => {
    await expect(
      getReleaseNotesCommand(memberAuth, { version: '0.15.0' }),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns no notes when an allowed update is absent from the changelog', async () => {
    mockReadFile.mockResolvedValue(`# Changelog

## 0.14.0 (2026-07-19)

Installed release.
`);

    await expect(
      getReleaseNotesCommand(adminAuth, { version: '0.15.0' }),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

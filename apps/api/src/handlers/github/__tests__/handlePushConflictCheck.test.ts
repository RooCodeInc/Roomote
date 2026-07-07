import type { Mock } from 'vitest';

const {
  mockGetRedis,
  mockGetInstallationOctokit,
  mockIsRepoSkipped,
  mockFindRepository,
  mockDiscoverCandidates,
  mockProcessConflictCandidates,
  mockGetBackgroundAgentSettingsForOrg,
} = vi.hoisted(() => {
  type AnyMock = Mock<(...args: never[]) => unknown>;

  return {
    mockGetRedis: vi.fn(() => ({})) as AnyMock,
    mockGetInstallationOctokit: vi.fn() as AnyMock,
    mockIsRepoSkipped: vi.fn() as AnyMock,
    mockFindRepository: vi.fn() as AnyMock,
    mockDiscoverCandidates: vi.fn() as AnyMock,
    mockProcessConflictCandidates: vi.fn() as AnyMock,
    mockGetBackgroundAgentSettingsForOrg: vi.fn() as AnyMock,
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: mockGetRedis,
}));

vi.mock('@roomote/github', () => ({
  getInstallationOctokit: mockGetInstallationOctokit,
  isRepoSkipped: mockIsRepoSkipped,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findFirst: mockFindRepository,
      },
    },
  },
  repositories: {
    githubRepoId: 'githubRepoId',
    isActive: 'isActive',
  },
  eq: vi.fn(),
  and: vi.fn(),
  getBackgroundAgentSettingsForDeployment: mockGetBackgroundAgentSettingsForOrg,
}));

vi.mock('../conflict-resolution', () => ({
  discoverCandidates: mockDiscoverCandidates,
  processConflictCandidates: mockProcessConflictCandidates,
  LOG_PREFIX: '[conflict-resolution]',
}));

import { handlePushConflictCheck } from '../handlePushConflictCheck';

const createPayload = () => ({
  ref: 'refs/heads/main',
  repository: {
    id: 123,
    full_name: 'Roomote/example-app',
    name: 'example-app',
    owner: { login: 'Roomote' },
  },
  installation: { id: 456 },
});

describe('handlePushConflictCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFindRepository.mockResolvedValue({ orgId: 'org-1' });
    mockGetBackgroundAgentSettingsForOrg.mockResolvedValue({
      conflictResolverFrequency: 'daily',
      conflictResolverMaxPrAgeDays: 7 as const,
      conflictResolverLabel: 'roomote:auto-resolve-conflicts',
    });
    mockDiscoverCandidates.mockResolvedValue([]);
    mockProcessConflictCandidates.mockResolvedValue(0);
    mockGetInstallationOctokit.mockResolvedValue({ rest: {} });
  });

  it('skips repos in GITHUB_AUTOMATED_SKIP_REPOS before scanning push conflicts', async () => {
    mockIsRepoSkipped.mockReturnValue(true);

    const result = await handlePushConflictCheck(createPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'Skipping push webhook for Roomote/example-app',
    });
    expect(mockIsRepoSkipped).toHaveBeenCalledWith('Roomote/example-app');
    expect(mockFindRepository).not.toHaveBeenCalled();
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    expect(mockDiscoverCandidates).not.toHaveBeenCalled();
    expect(mockProcessConflictCandidates).not.toHaveBeenCalled();
  });

  it('continues processing repos that are not skipped', async () => {
    const octokit = { rest: {} };

    mockIsRepoSkipped.mockReturnValue(false);
    mockGetInstallationOctokit.mockResolvedValue(octokit);

    const result = await handlePushConflictCheck(createPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'No candidate PRs found',
    });
    expect(mockIsRepoSkipped).toHaveBeenCalledWith('Roomote/example-app');
    expect(mockFindRepository).toHaveBeenCalledOnce();
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith({
      installationId: 456,
    });
    expect(mockDiscoverCandidates).toHaveBeenCalledWith(
      octokit,
      'Roomote',
      'example-app',
      'main',
      'roomote:auto-resolve-conflicts',
      7,
    );
  });
});

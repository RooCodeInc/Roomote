const {
  mockSelectLimit,
  mockGithubUserMappingsFindFirst,
  mockGetReviewCodeAutomationSettings,
} = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockGithubUserMappingsFindFirst: vi.fn(),
  mockGetReviewCodeAutomationSettings: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      githubUserMappings: {
        findFirst: (arg: unknown) => mockGithubUserMappingsFindFirst(arg),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: (...args: unknown[]) => mockSelectLimit(...args),
          })),
        })),
      })),
    })),
  },
  repositories: {
    installationId: 'repositories.installationId',
    githubRepoId: 'repositories.githubRepoId',
    isActive: 'repositories.isActive',
  },
  githubInstallations: {
    id: 'githubInstallations.id',
    installationId: 'githubInstallations.installationId',
  },
  githubUserMappings: { githubUserId: 'githubUserMappings.githubUserId' },
  getReviewCodeAutomationSettings: () => mockGetReviewCodeAutomationSettings(),
  eq: (left: unknown, right: unknown) => ({ left, right }),
  and: (...args: unknown[]) => args,
}));

import { getGitHubAutomationTargets } from '../getGitHubAutomationTargets';

const request = {
  workflow: 'pr_review' as const,
  installation: { id: 145598580 },
  repository: { id: 1001, full_name: 'acme/forge' },
  sender: { id: 2002, login: 'alice' },
  author: 'alice',
} as Parameters<typeof getGitHubAutomationTargets>[0];

describe('getGitHubAutomationTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelectLimit.mockResolvedValue([
      {
        repositories: { id: 'repo-1', fullName: 'acme/forge' },
        github_installations: { id: 'installation-row-1' },
      },
    ]);
    mockGithubUserMappingsFindFirst.mockResolvedValue({ userId: 'user-1' });
    mockGetReviewCodeAutomationSettings.mockResolvedValue({
      enabled: true,
      reviewAllPullRequestAuthors: true,
    });
  });

  it('returns a review target for a repository that no environment includes', async () => {
    // Review tasks fall back to a plain repository checkout when no
    // environment includes the repository, so the target must not require
    // an environment mapping.
    const result = await getGitHubAutomationTargets(request);

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_review:repo-1',
          repositoryIds: ['repo-1'],
          properties: { userId: 'user-1', githubLogin: 'alice' },
        },
      ],
    });
  });

  it('returns no targets when Review Code automation is disabled', async () => {
    mockGetReviewCodeAutomationSettings.mockResolvedValue({ enabled: false });

    await expect(getGitHubAutomationTargets(request)).resolves.toEqual({
      status: 'ok',
      targets: [],
    });
  });

  it('rejects a repository that is not active in the deployment', async () => {
    mockSelectLimit.mockResolvedValue([]);

    await expect(getGitHubAutomationTargets(request)).resolves.toEqual({
      status: 'error',
      message: 'no active repository associated with [145598580, acme/forge]',
    });
  });
});

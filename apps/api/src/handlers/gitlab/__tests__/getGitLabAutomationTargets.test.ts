const {
  mockRepositoriesFindFirst,
  mockAuthAccountsFindFirst,
  mockSelectWhere,
  mockGetReviewCodeAutomationSettings,
  mockAnd,
  mockEq,
  mockOr,
  mockDesc,
} = vi.hoisted(() => ({
  mockRepositoriesFindFirst: vi.fn(),
  mockAuthAccountsFindFirst: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockGetReviewCodeAutomationSettings: vi.fn(),
  mockAnd: vi.fn((...args: unknown[]) => args),
  mockEq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  mockOr: vi.fn((...args: unknown[]) => args),
  mockDesc: vi.fn((value: unknown) => value),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findFirst: (arg: unknown) => mockRepositoriesFindFirst(arg),
      },
      authAccounts: {
        findFirst: (arg: unknown) => mockAuthAccountsFindFirst(arg),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: (...args: unknown[]) => mockSelectWhere(...args),
      })),
    })),
  },
  repositories: {
    sourceControlProvider: 'repositories.sourceControlProvider',
    isActive: 'repositories.isActive',
    externalRepoId: 'repositories.externalRepoId',
    fullName: 'repositories.fullName',
  },
  authAccounts: {
    providerId: 'authAccounts.providerId',
    accountId: 'authAccounts.accountId',
    updatedAt: 'authAccounts.updatedAt',
  },
  environmentRepositoryMappings: {
    environmentId: 'environmentRepositoryMappings.environmentId',
    repositoryId: 'environmentRepositoryMappings.repositoryId',
  },
  getReviewCodeAutomationSettings: () => mockGetReviewCodeAutomationSettings(),
  eq: (left: unknown, right: unknown) => mockEq(left, right),
  and: (...args: unknown[]) => mockAnd(...args),
  or: (...args: unknown[]) => mockOr(...args),
  desc: (value: unknown) => mockDesc(value),
}));

import { getGitLabAutomationTargets } from '../getGitLabAutomationTargets';

describe('getGitLabAutomationTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRepositoriesFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'acme/backend',
      linkedByUserId: 'repo-owner-1',
    });
    mockAuthAccountsFindFirst.mockResolvedValue(null);
    mockSelectWhere.mockResolvedValue([{ environmentId: 'env-1' }]);
    mockGetReviewCodeAutomationSettings.mockResolvedValue({
      enabled: true,
      reviewAllPullRequestAuthors: false,
    });
  });

  it('uses the stable GitLab numeric user id for linked-account matching', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({ userId: 'linked-user-1' });

    const result = await getGitLabAutomationTargets({
      workflow: 'pr_review',
      payload: {
        project: { id: 42, path_with_namespace: 'acme/backend' },
        user: { id: 987, username: 'alice' },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          id: 'gitlab:pr_review:repo-1',
          userId: 'linked-user-1',
        },
      ],
    });
    expect(mockAuthAccountsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          expect.objectContaining({
            left: 'authAccounts.accountId',
            right: '987',
          }),
        ]),
      }),
    );
  });

  it('returns account_link_required before environment gating for unlinked commenters', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const result = await getGitLabAutomationTargets({
      workflow: 'pr_review',
      payload: {
        project: { id: 42, path_with_namespace: 'acme/backend' },
        user: { id: 987, username: 'alice' },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toEqual({
      status: 'error',
      code: 'account_link_required',
      message: 'GitLab user alice is not linked to a Roomote user',
    });
    expect(mockGetReviewCodeAutomationSettings).not.toHaveBeenCalled();
  });

  it('still enforces environment mapping after a linked sender is resolved', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({ userId: 'linked-user-1' });
    mockSelectWhere.mockResolvedValue([]);

    const result = await getGitLabAutomationTargets({
      workflow: 'pr_review',
      payload: {
        project: { id: 42, path_with_namespace: 'acme/backend' },
        user: { id: 987, username: 'alice' },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toEqual({
      status: 'error',
      message:
        'no environment mapping associated with [gitlab:42, acme/backend]',
    });
  });
});

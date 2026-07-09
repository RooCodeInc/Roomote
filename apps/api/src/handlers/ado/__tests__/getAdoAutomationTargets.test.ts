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
  mockDesc: vi.fn((column: unknown) => ({ desc: column })),
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
  environmentRepositoryMappings: {
    environmentId: 'environmentRepositoryMappings.environmentId',
    repositoryId: 'environmentRepositoryMappings.repositoryId',
  },
  authAccounts: {
    providerId: 'authAccounts.providerId',
    accountId: 'authAccounts.accountId',
    updatedAt: 'authAccounts.updatedAt',
  },
  getReviewCodeAutomationSettings: () => mockGetReviewCodeAutomationSettings(),
  desc: (column: unknown) => mockDesc(column),
  eq: (left: unknown, right: unknown) => mockEq(left, right),
  and: (...args: unknown[]) => mockAnd(...args),
  or: (...args: unknown[]) => mockOr(...args),
}));

import { CloudAgentType } from '@roomote/types';

import { getAdoAutomationTargets } from '../getAdoAutomationTargets';

const payload = {
  repositoryFullName: 'acme/Platform/backend',
  resource: {
    repository: {
      id: 'repo-1',
      name: 'backend',
      project: { id: 'project-1', name: 'Platform' },
    },
    pullRequestId: 42,
    title: 'Update backend',
    createdBy: { uniqueName: 'roomote-bot@acme.example' },
  },
};

describe('getAdoAutomationTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRepositoriesFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'acme/Platform/backend',
      linkedByUserId: 'repo-owner-1',
    });
    mockSelectWhere.mockResolvedValue([{ environmentId: 'env-1' }]);
    mockAuthAccountsFindFirst.mockResolvedValue(null);
    mockGetReviewCodeAutomationSettings.mockResolvedValue({
      enabled: true,
      reviewAllPullRequestAuthors: false,
    });
  });

  it('returns reviewer targets for active synced Azure DevOps repositories', async () => {
    const result = await getAdoAutomationTargets({
      type: CloudAgentType.PrReviewer,
      payload,
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          id: 'ado:PR Reviewer:repo-1',
          // The repo-linker fallback owner is gone: webhook launches carry an
          // automation initiator instead of a forged owner.
          userId: null,
        },
      ],
    });
  });

  it('enforces environment mapping for review automation', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const result = await getAdoAutomationTargets({
      type: CloudAgentType.PrReviewer,
      payload,
    });

    expect(result).toEqual({
      status: 'error',
      message:
        'no environment mapping associated with [ado:repo-1, acme/Platform/backend]',
    });
  });

  it('applies PR author policy unless explicitly ignored', async () => {
    const humanPayload = {
      ...payload,
      resource: {
        ...payload.resource,
        createdBy: { uniqueName: 'alice@example.com' },
      },
    };

    await expect(
      getAdoAutomationTargets({
        type: CloudAgentType.PrReviewer,
        payload: humanPayload,
      }),
    ).resolves.toEqual({
      status: 'error',
      message: 'Azure DevOps PR author is not allowed: alice@example.com',
    });

    await expect(
      getAdoAutomationTargets({
        type: CloudAgentType.PrReviewer,
        payload: humanPayload,
        ignoreAuthorPolicy: true,
      }),
    ).resolves.toMatchObject({ status: 'ok' });
  });

  it('uses the linked Azure DevOps commenter account for comment-triggered work', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({ userId: 'commenter-user-1' });

    const result = await getAdoAutomationTargets({
      type: CloudAgentType.PrReviewer,
      payload: {
        ...payload,
        commentAuthor: {
          id: 'ado-user-1',
          uniqueName: 'alice@acme.example',
        },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          userId: 'commenter-user-1',
        },
      ],
    });
    expect(mockAuthAccountsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          expect.objectContaining({ left: 'authAccounts.providerId' }),
          expect.objectContaining({ left: 'authAccounts.accountId' }),
        ]),
      }),
    );
  });

  it('requires an Azure DevOps linked account when comment attribution is required', async () => {
    const result = await getAdoAutomationTargets({
      type: CloudAgentType.PrReviewer,
      payload: {
        ...payload,
        commentAuthor: {
          id: 'ado-user-1',
          uniqueName: 'alice@acme.example',
        },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toEqual({
      status: 'error',
      code: 'account_link_required',
      message:
        'Azure DevOps user alice@acme.example is not linked to a Roomote user',
    });
  });
});

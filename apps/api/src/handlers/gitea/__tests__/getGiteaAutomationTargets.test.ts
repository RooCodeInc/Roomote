const {
  mockRepositoriesFindMany,
  mockAuthAccountsFindFirst,
  mockSelectWhere,
  mockGetReviewCodeAutomationSettings,
  mockAnd,
  mockEq,
  mockOr,
  mockDesc,
} = vi.hoisted(() => ({
  mockRepositoriesFindMany: vi.fn(),
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
        findMany: (arg: unknown) => mockRepositoriesFindMany(arg),
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

import { getGiteaAutomationTargets } from '../getGiteaAutomationTargets';

describe('getGiteaAutomationTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRepositoriesFindMany.mockResolvedValue([
      {
        id: 'repo-1',
        fullName: 'acme/backend',
        host: null,
        linkedByUserId: 'repo-owner-1',
      },
    ]);
    mockAuthAccountsFindFirst.mockResolvedValue(null);
    mockSelectWhere.mockResolvedValue([{ environmentId: 'env-1' }]);
    mockGetReviewCodeAutomationSettings.mockResolvedValue({
      enabled: true,
      reviewAllPullRequestAuthors: false,
    });
  });

  it('returns reviewer targets for active synced Gitea repositories', async () => {
    const result = await getGiteaAutomationTargets({
      workflow: 'pr_review',
      payload: {
        repository: { id: 42, full_name: 'acme/backend' },
        sender: { id: 987, login: 'roomote-bot' },
      },
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_review:repo-1',
          // The repo-linker fallback owner is gone: webhook launches carry
          // an automation initiator instead of a forged owner.
          userId: null,
        },
      ],
    });
  });

  it('enforces environment mapping for review automation', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const result = await getGiteaAutomationTargets({
      workflow: 'pr_review',
      payload: {
        repository: { id: 42, full_name: 'acme/backend' },
        sender: { id: 987, login: 'roomote-bot' },
      },
    });

    expect(result).toEqual({
      status: 'error',
      message:
        'no environment mapping associated with [gitea:42, acme/backend]',
    });
  });

  it('applies PR author policy unless explicitly ignored', async () => {
    await expect(
      getGiteaAutomationTargets({
        workflow: 'pr_review',
        payload: {
          repository: { id: 42, full_name: 'acme/backend' },
          sender: { id: 987, login: 'alice' },
        },
      }),
    ).resolves.toEqual({
      status: 'error',
      message: 'Gitea PR author is not allowed: alice',
    });

    await expect(
      getGiteaAutomationTargets({
        workflow: 'pr_review',
        payload: {
          repository: { id: 42, full_name: 'acme/backend' },
          sender: { id: 987, login: 'alice' },
        },
        ignoreAuthorPolicy: true,
      }),
    ).resolves.toMatchObject({ status: 'ok' });
  });

  it('uses the linked Gitea commenter account for comment-triggered work', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({ userId: 'commenter-user-1' });

    const result = await getGiteaAutomationTargets({
      workflow: 'pr_review',
      payload: {
        repository: { id: 42, full_name: 'acme/backend' },
        sender: { id: 10, login: 'repo-owner' },
        commentAuthor: { id: 987, login: 'alice' },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_review:repo-1',
          userId: 'commenter-user-1',
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

    const result = await getGiteaAutomationTargets({
      workflow: 'pr_review',
      payload: {
        repository: { id: 42, full_name: 'acme/backend' },
        sender: { id: 10, login: 'repo-owner' },
        commentAuthor: { id: 987, login: 'alice' },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toEqual({
      status: 'error',
      code: 'account_link_required',
      message: 'Gitea user alice is not linked to a Roomote user',
    });
    expect(mockGetReviewCodeAutomationSettings).not.toHaveBeenCalled();
  });

  it('still enforces environment mapping after a linked sender is resolved', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({ userId: 'commenter-user-1' });
    mockSelectWhere.mockResolvedValue([]);

    const result = await getGiteaAutomationTargets({
      workflow: 'pr_review',
      payload: {
        repository: { id: 42, full_name: 'acme/backend' },
        sender: { id: 10, login: 'repo-owner' },
        commentAuthor: { id: 987, login: 'alice' },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toEqual({
      status: 'error',
      message:
        'no environment mapping associated with [gitea:42, acme/backend]',
    });
  });

  it('selects the repository row matching the webhook host among same-name rows', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      {
        id: 'repo-host-a',
        fullName: 'acme/backend',
        host: 'gitea.host-a.example',
      },
      {
        id: 'repo-host-b',
        fullName: 'acme/backend',
        host: 'gitea.host-b.example',
      },
    ]);

    const result = await getGiteaAutomationTargets({
      workflow: 'pr_review',
      payload: {
        repository: { id: 42, full_name: 'acme/backend' },
        sender: { id: 987, login: 'roomote-bot' },
      },
      webhookHost: 'gitea.host-b.example',
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_review:repo-host-b',
          repo: { id: 'repo-host-b', host: 'gitea.host-b.example' },
        },
      ],
    });
  });

  it('falls back to a legacy null-host row for a host-scoped lookup', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      { id: 'repo-legacy', fullName: 'acme/backend', host: null },
    ]);

    const result = await getGiteaAutomationTargets({
      workflow: 'pr_review',
      payload: {
        repository: { id: 42, full_name: 'acme/backend' },
        sender: { id: 987, login: 'roomote-bot' },
      },
      webhookHost: 'gitea.host-a.example',
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [{ repo: { id: 'repo-legacy', host: null } }],
    });
  });
});

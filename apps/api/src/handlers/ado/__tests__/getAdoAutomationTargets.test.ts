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
  mockDesc: vi.fn((column: unknown) => ({ desc: column })),
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

import {
  getAdoAutomationTargets,
  isRoomoteAdoIdentity,
} from '../getAdoAutomationTargets';

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

    mockRepositoriesFindMany.mockResolvedValue([
      {
        id: 'repo-1',
        fullName: 'acme/Platform/backend',
        host: null,
        linkedByUserId: 'repo-owner-1',
      },
    ]);
    mockSelectWhere.mockResolvedValue([{ environmentId: 'env-1' }]);
    mockAuthAccountsFindFirst.mockResolvedValue(null);
    mockGetReviewCodeAutomationSettings.mockResolvedValue({
      enabled: true,
      reviewAllPullRequestAuthors: false,
    });
  });

  it('returns reviewer targets for active synced Azure DevOps repositories', async () => {
    const result = await getAdoAutomationTargets({
      workflow: 'pr_review',
      payload,
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          id: 'ado:pr_review:repo-1',
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
      workflow: 'pr_review',
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
        workflow: 'pr_review',
        payload: humanPayload,
      }),
    ).resolves.toEqual({
      status: 'error',
      message: 'Azure DevOps PR author is not allowed: alice@example.com',
    });

    await expect(
      getAdoAutomationTargets({
        workflow: 'pr_review',
        payload: humanPayload,
        ignoreAuthorPolicy: true,
      }),
    ).resolves.toMatchObject({ status: 'ok' });
  });

  it('matches the linked account on the commenter uniqueName, not the id', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({ userId: 'commenter-user-1' });

    const result = await getAdoAutomationTargets({
      workflow: 'pr_review',
      payload: {
        ...payload,
        commentAuthor: {
          // The webhook author id is a different Azure DevOps id namespace
          // than the linked account, so matching must ignore it and use the
          // normalized uniqueName instead.
          id: 'org-identity-id-that-never-matches',
          uniqueName: 'Alice@Acme.Example',
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
          expect.objectContaining({
            left: 'authAccounts.accountId',
            right: 'alice@acme.example',
          }),
        ]),
      }),
    );
  });

  it('requires a link when the commenter has no uniqueName to match', async () => {
    const result = await getAdoAutomationTargets({
      workflow: 'pr_review',
      payload: {
        ...payload,
        commentAuthor: {
          id: 'org-identity-id',
          displayName: 'Alice',
        },
      },
      ignoreAuthorPolicy: true,
      requireLinkedSenderAccount: true,
    });

    expect(result).toMatchObject({
      status: 'error',
      code: 'account_link_required',
    });
    expect(mockAuthAccountsFindFirst).not.toHaveBeenCalled();
  });

  it('requires an Azure DevOps linked account when comment attribution is required', async () => {
    const result = await getAdoAutomationTargets({
      workflow: 'pr_review',
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
  it('selects the repository row matching the webhook host among same-name rows', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      {
        id: 'repo-host-a',
        fullName: 'acme/Platform/backend',
        host: 'ado.host-a.example',
      },
      {
        id: 'repo-host-b',
        fullName: 'acme/Platform/backend',
        host: 'ado.host-b.example',
      },
    ]);

    const result = await getAdoAutomationTargets({
      workflow: 'pr_review',
      payload,
      webhookHost: 'ado.host-b.example',
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [
        {
          id: 'ado:pr_review:repo-host-b',
          repo: { id: 'repo-host-b', host: 'ado.host-b.example' },
        },
      ],
    });
  });

  it('falls back to a legacy null-host row for a host-scoped lookup', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      { id: 'repo-legacy', fullName: 'acme/Platform/backend', host: null },
    ]);

    const result = await getAdoAutomationTargets({
      workflow: 'pr_review',
      payload,
      webhookHost: 'ado.host-a.example',
    });

    expect(result).toMatchObject({
      status: 'ok',
      targets: [{ repo: { id: 'repo-legacy', host: null } }],
    });
  });
});

describe('isRoomoteAdoIdentity', () => {
  it('matches Roomote bot identities by name or handle', () => {
    expect(isRoomoteAdoIdentity('roomote')).toBe(true);
    expect(isRoomoteAdoIdentity('Roomote Bot')).toBe(true);
    expect(isRoomoteAdoIdentity('roomote-bot@acme.example')).toBe(true);
    expect(isRoomoteAdoIdentity('@roomote')).toBe(true);
  });

  it('does not match humans whose email domain contains roomote', () => {
    // Regression: a bare `@roomote` substring check treated every user in a
    // `roomote.*` Entra tenant as Roomote's own bot and dropped their
    // mentions.
    expect(isRoomoteAdoIdentity('grace@roomote.onmicrosoft.com')).toBe(false);
    expect(isRoomoteAdoIdentity('alice@roomote.dev')).toBe(false);
    expect(isRoomoteAdoIdentity('Grace Hopper')).toBe(false);
  });
});

const {
  mockCreateAdoWorkItemComment,
  mockGetAdoDeploymentUser,
  mockDbQuery,
  mockResolveMappedEnvironmentId,
  mockPickHostScopedRepository,
  mockStartSourceControlFastSessionTurn,
  mockFindReusableGitHubIssueTaskOwner,
} = vi.hoisted(() => ({
  mockCreateAdoWorkItemComment: vi.fn(),
  mockGetAdoDeploymentUser: vi.fn(),
  mockDbQuery: {
    repositories: { findMany: vi.fn() },
    authAccounts: { findFirst: vi.fn() },
  },
  mockResolveMappedEnvironmentId: vi.fn(),
  mockPickHostScopedRepository: vi.fn(),
  mockStartSourceControlFastSessionTurn: vi.fn(),
  mockFindReusableGitHubIssueTaskOwner: vi.fn(),
}));

vi.mock('@roomote/ado', () => ({
  createAdoWorkItemComment: mockCreateAdoWorkItemComment,
  getAdoDeploymentUser: mockGetAdoDeploymentUser,
  normalizeAdoLinkedAccountKey: (value?: string | null) =>
    value?.trim().toLowerCase() || null,
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: mockDbQuery },
  authAccounts: {},
  repositories: {
    sourceControlProvider: 'sourceControlProvider',
    isActive: 'isActive',
  },
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  eq: (left: unknown, right: unknown) => ({ left, right }),
  findActiveGitHubPrReviewTask: vi.fn(),
  findReusableGitHubIssueTaskOwner: mockFindReusableGitHubIssueTaskOwner,
  findReusableGitHubPrFollowUpOwner: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  startSourceControlFastSessionTurn: mockStartSourceControlFastSessionTurn,
}));

vi.mock('../../utils', () => ({
  pickHostScopedRepository: mockPickHostScopedRepository,
  toHostFromUrl: (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  },
}));

vi.mock('../../source-control-account-linking', () => ({
  buildSourceControlAccountLinkRequiredMessage: async () =>
    'link your Azure DevOps account',
}));

vi.mock('../../shared/repository-environment', () => ({
  resolveMappedEnvironmentId: mockResolveMappedEnvironmentId,
}));

vi.mock('../getAdoAutomationTargets', () => ({
  getAdoIdentityName: (identity?: {
    uniqueName?: string;
    displayName?: string;
  }) => identity?.uniqueName ?? identity?.displayName,
  isRoomoteAdoIdentity: (identityName: string) => {
    const normalized = identityName.toLowerCase().trim();
    return (
      normalized.startsWith('roomote') || normalized.startsWith('@roomote')
    );
  },
}));

import { handleAdoWorkItemComment } from '../handleWorkItemComment';
import type { AdoWorkItemCommentedWebhook } from '../types';

function makeWorkItemPayload(
  overrides: { fields?: Record<string, unknown> } = {},
): AdoWorkItemCommentedWebhook {
  return {
    id: 'wi-delivery-1',
    eventType: 'workitem.commented',
    publisherId: 'tfs',
    resourceContainers: {
      account: { baseUrl: 'https://dev.azure.com/acme/' },
      project: {
        id: 'project-1',
        baseUrl: 'https://dev.azure.com/acme/Platform/',
      },
    },
    resource: {
      id: 77,
      rev: 3,
      fields: {
        'System.Id': 77,
        'System.Title': 'Investigate failed deploy',
        'System.Description': 'Deploy exploded in prod.',
        'System.History': '@roomote investigate failed deploy',
        'System.TeamProject': 'Platform',
        'System.WorkItemType': 'Bug',
        'System.ChangedBy': {
          id: 'ado-user-1',
          uniqueName: 'alice@acme.example',
          displayName: 'Alice',
        },
        ...(overrides.fields ?? {}),
      },
      _links: {
        html: {
          href: 'https://dev.azure.com/acme/Platform/_workitems/edit/77',
        },
      },
    },
  } as AdoWorkItemCommentedWebhook;
}

const repositoryRow = {
  id: 'repo-row-1',
  fullName: 'acme/Platform/backend',
  host: 'dev.azure.com',
  sourceControlProvider: 'ado',
  isActive: true,
  permissions: { projectId: 'project-1' },
};

describe('handleAdoWorkItemComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdoDeploymentUser.mockResolvedValue({
      id: 'ado-roomote-bot',
      uniqueName: 'roomote-bot@acme.example',
      displayName: 'Roomote Bot',
    });
    mockDbQuery.repositories.findMany.mockResolvedValue([repositoryRow]);
    mockPickHostScopedRepository.mockImplementation(
      (rows: unknown[]) => rows[0] ?? null,
    );
    mockResolveMappedEnvironmentId.mockResolvedValue('env-1');
    mockDbQuery.authAccounts.findFirst.mockResolvedValue({ userId: 'user-1' });
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue(null);
    mockStartSourceControlFastSessionTurn.mockResolvedValue({
      status: 'queued',
      fastConversationId: 'fast-1',
    });
    mockCreateAdoWorkItemComment.mockResolvedValue({ commentId: '1' });
  });

  it('enters a work item mention into the work item Session', async () => {
    const result = await handleAdoWorkItemComment(makeWorkItemPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'fast_session_queued',
      metadata: { fastConversationId: 'fast-1' },
    });
    expect(mockStartSourceControlFastSessionTurn).toHaveBeenCalledWith({
      discussion: {
        provider: 'ado',
        host: 'dev.azure.com',
        repositoryFullName: 'acme/Platform/backend',
        kind: 'issues',
        number: 77,
      },
      userId: 'user-1',
      senderDisplayName: 'alice@acme.example',
      question: '@roomote investigate failed deploy',
      agentContext: expect.stringContaining(
        'Work item: #77 - Investigate failed deploy',
      ),
      currentMessageId: 'ado:work-item:77:3',
      activeTasks: [],
    });
    const context = mockStartSourceControlFastSessionTurn.mock.calls[0]?.[0]
      .agentContext as string;
    expect(context).toContain('Type: Bug');
    expect(context).toContain('> Deploy exploded in prod.');
    expect(mockCreateAdoWorkItemComment).not.toHaveBeenCalled();
  });

  it('asks an unlinked commenter to link their account', async () => {
    mockDbQuery.authAccounts.findFirst.mockResolvedValue(null);

    const result = await handleAdoWorkItemComment(makeWorkItemPayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mockCreateAdoWorkItemComment).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'Platform',
        workItemId: 77,
        body: 'link your Azure DevOps account',
      }),
    );
    expect(mockStartSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });

  it('tells the commenter when the Session cannot start', async () => {
    mockStartSourceControlFastSessionTurn.mockResolvedValue({
      status: 'unavailable',
    });

    const result = await handleAdoWorkItemComment(makeWorkItemPayload());

    expect(result).toEqual({ status: 'error', message: 'fast_unavailable' });
    expect(mockCreateAdoWorkItemComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("couldn't start a conversation"),
      }),
    );
  });

  it('ignores comments without a mention and Roomote-authored comments', async () => {
    await expect(
      handleAdoWorkItemComment(
        makeWorkItemPayload({ fields: { 'System.History': 'plain note' } }),
      ),
    ).resolves.toEqual({ status: 'ok', message: 'no_mention' });
    await expect(
      handleAdoWorkItemComment(
        makeWorkItemPayload({
          fields: {
            'System.ChangedBy': {
              id: 'ado-roomote-bot',
              uniqueName: 'roomote-bot@acme.example',
              displayName: 'Roomote Bot',
            },
          },
        }),
      ),
    ).resolves.toEqual({ status: 'ok', message: 'roomote_authored_comment' });
    expect(mockStartSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });
});

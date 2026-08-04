const {
  mockOrchestrateIssueMention,
  mockCreateAdoWorkItemComment,
  mockGetAdoDeploymentUser,
  mockDbQuery,
  mockResolveMappedEnvironmentId,
  mockPickHostScopedRepository,
} = vi.hoisted(() => ({
  mockOrchestrateIssueMention: vi.fn(),
  mockCreateAdoWorkItemComment: vi.fn(),
  mockGetAdoDeploymentUser: vi.fn(),
  mockDbQuery: {
    repositories: { findMany: vi.fn() },
    authAccounts: { findFirst: vi.fn() },
  },
  mockResolveMappedEnvironmentId: vi.fn(),
  mockPickHostScopedRepository: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: vi.fn(
    ({ taskId }: { taskId: string }) =>
      `https://roomote.example/tasks/${taskId}`,
  ),
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

vi.mock('../../shared/issue-mention-orchestration', () => ({
  orchestrateIssueMention: mockOrchestrateIssueMention,
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
  overrides: {
    fields?: Record<string, unknown>;
    resource?: Partial<AdoWorkItemCommentedWebhook['resource']>;
    resourceContainers?: AdoWorkItemCommentedWebhook['resourceContainers'];
  } = {},
): AdoWorkItemCommentedWebhook {
  return {
    id: 'wi-delivery-1',
    eventType: 'workitem.commented',
    publisherId: 'tfs',
    resourceContainers: overrides.resourceContainers ?? {
      account: {
        baseUrl: 'https://dev.azure.com/acme/',
      },
      project: {
        id: 'project-1',
        baseUrl: 'https://dev.azure.com/acme/Platform/',
      },
    },
    resource: {
      id: 77,
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
      ...overrides.resource,
    },
  };
}

describe('handleAdoWorkItemComment', () => {
  beforeEach(() => {
    mockOrchestrateIssueMention.mockReset();
    mockCreateAdoWorkItemComment.mockReset();
    mockGetAdoDeploymentUser.mockReset();
    mockDbQuery.repositories.findMany.mockReset();
    mockDbQuery.authAccounts.findFirst.mockReset();
    mockResolveMappedEnvironmentId.mockReset();
    mockPickHostScopedRepository.mockReset();

    mockGetAdoDeploymentUser.mockResolvedValue({
      id: 'ado-roomote-bot',
      uniqueName: 'roomote-bot@acme.example',
      displayName: 'Roomote Bot',
    });
    mockDbQuery.repositories.findMany.mockResolvedValue([
      {
        id: 'repo-row-1',
        fullName: 'acme/Platform/backend',
        host: 'dev.azure.com',
        permissions: { projectId: 'project-1' },
      },
    ]);
    mockPickHostScopedRepository.mockImplementation(
      (rows: { id: string }[]) => rows[0] ?? null,
    );
    mockResolveMappedEnvironmentId.mockResolvedValue('env-1');
    mockDbQuery.authAccounts.findFirst.mockResolvedValue({
      userId: 'user-1',
    });
    mockOrchestrateIssueMention.mockResolvedValue({
      status: 'ok',
      metadata: { ids: [9] },
    });
    mockCreateAdoWorkItemComment.mockResolvedValue({ commentId: 'c1' });
  });

  it('starts a standard task for @roomote work-item comments', async () => {
    const result = await handleAdoWorkItemComment(makeWorkItemPayload());

    expect(result).toEqual({ status: 'ok', metadata: { ids: [9] } });
    expect(mockOrchestrateIssueMention).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ado',
        repositoryId: 'repo-row-1',
        repositoryFullName: 'acme/Platform/backend',
        issueNumber: 77,
        issueTitle: 'Investigate failed deploy',
        issueUrl: 'https://dev.azure.com/acme/Platform/_workitems/edit/77',
        commentBody: '@roomote investigate failed deploy',
        commenterLogin: 'alice@acme.example',
        commenterUserId: 'user-1',
        includeSourceControlOnPayload: true,
        resourceLabel: 'bug work item',
        providerDisplayName: 'Azure DevOps',
      }),
    );
  });

  it('ignores comments without an @roomote mention', async () => {
    const result = await handleAdoWorkItemComment(
      makeWorkItemPayload({
        fields: { 'System.History': 'looking into this' },
      }),
    );

    expect(result).toEqual({ status: 'ok', message: 'no_mention' });
    expect(mockOrchestrateIssueMention).not.toHaveBeenCalled();
  });

  it('ignores Roomote-authored work item comments', async () => {
    const result = await handleAdoWorkItemComment(
      makeWorkItemPayload({
        fields: {
          'System.ChangedBy': {
            id: 'ado-roomote-bot',
            uniqueName: 'roomote-bot@acme.example',
            displayName: 'Roomote Bot',
          },
        },
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'roomote_authored_comment',
    });
    expect(mockOrchestrateIssueMention).not.toHaveBeenCalled();
  });

  it('asks the commenter to link their account when unlinked', async () => {
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
    expect(mockOrchestrateIssueMention).not.toHaveBeenCalled();
  });

  it('accepts Microsoft sample flat workitem.commented fields', async () => {
    const result = await handleAdoWorkItemComment(
      makeWorkItemPayload({
        fields: {
          'System.ChangedBy': 'Alice Example',
          // identity is a display name only in Microsoft's sample; link key
          // gets uniqueName when present as "Name <email>".
          'System.History': '@roomote look into the deploy',
        },
      }),
    );

    // Display-name-only authors cannot match linked UPN keys.
    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
  });

  it('reads comment text from revision.fields when flat History is absent', async () => {
    const payload = makeWorkItemPayload({
      fields: {
        'System.History': undefined,
        'System.ChangedBy': undefined,
      },
      resource: {
        fields: {
          'System.Id': 77,
          'System.Title': 'Investigate failed deploy',
          'System.TeamProject': 'Platform',
          'System.WorkItemType': 'Bug',
        },
        revision: {
          fields: {
            'System.History': {
              newValue: '@roomote investigate failed deploy',
            },
          },
          revisedBy: {
            id: 'ado-user-1',
            uniqueName: 'alice@acme.example',
            displayName: 'Alice',
          },
        },
      },
    });

    const result = await handleAdoWorkItemComment(payload);

    expect(result).toEqual({ status: 'ok', metadata: { ids: [9] } });
    expect(mockOrchestrateIssueMention).toHaveBeenCalledWith(
      expect.objectContaining({
        commentBody: '@roomote investigate failed deploy',
        commenterLogin: 'alice@acme.example',
      }),
    );
  });
});

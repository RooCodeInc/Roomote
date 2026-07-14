const {
  mockEnqueueTask,
  mockGetAdoAutomationTargets,
  mockUpdateTaskPrStatus,
  mockRecordPrStatusChangeInTaskHistory,
  mockRepositoriesFindFirst,
  mockDedupSelect,
  mockScheduleNotifyPullRequestTerminalStatus,
  mockScheduleSourceControlPullRequestFactSync,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetAdoAutomationTargets: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
  mockRecordPrStatusChangeInTaskHistory: vi.fn(),
  mockRepositoriesFindFirst: vi.fn(),
  // Resolves the rows for each `db.select().from(tasks).innerJoin(...)`
  // dedup lookup, in call order.
  mockDedupSelect: vi.fn(),
  mockScheduleNotifyPullRequestTerminalStatus: vi.fn(),
  mockScheduleSourceControlPullRequestFactSync: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/sdk/server', () => ({
  updateTaskPrStatus: mockUpdateTaskPrStatus,
  recordPrStatusChangeInTaskHistory: mockRecordPrStatusChangeInTaskHistory,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findFirst: (...args: unknown[]) => mockRepositoriesFindFirst(...args),
      },
    },
    select: () => {
      const rowsPromise = Promise.resolve(mockDedupSelect());
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => rowsPromise,
      };
      return chain;
    },
  },
  repositories: {
    sourceControlProvider: 'repositories.sourceControlProvider',
    fullName: 'repositories.fullName',
    isActive: 'repositories.isActive',
  },
  tasks: {
    id: 'tasks.id',
    workflow: 'tasks.workflow',
  },
  taskPullRequests: {
    taskId: 'taskPullRequests.taskId',
    sourceControlProvider: 'taskPullRequests.sourceControlProvider',
    repository: 'taskPullRequests.repository',
    prNumber: 'taskPullRequests.prNumber',
    prSha: 'taskPullRequests.prSha',
  },
  taskRuns: {
    id: 'taskRuns.id',
    taskId: 'taskRuns.taskId',
    status: 'taskRuns.status',
    canceledAt: 'taskRuns.canceledAt',
    createdAt: 'taskRuns.createdAt',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  desc: vi.fn((column: unknown) => ({ type: 'desc', column })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  inArray: vi.fn((left: unknown, right: unknown) => ({
    type: 'inArray',
    left,
    right,
  })),
  isNotNull: vi.fn((column: unknown) => ({ type: 'isNotNull', column })),
  isNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    type: 'sql',
    strings,
    values,
  })),
}));

vi.mock('../../github/notifyPullRequestTerminalStatus', () => ({
  scheduleNotifyPullRequestTerminalStatus:
    mockScheduleNotifyPullRequestTerminalStatus,
}));

vi.mock('../../pull-request-fact-sync', () => ({
  scheduleSourceControlPullRequestFactSync:
    mockScheduleSourceControlPullRequestFactSync,
}));

vi.mock('../getAdoAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getAdoAutomationTargets')
  >('../getAdoAutomationTargets');

  return {
    ...actual,
    getAdoAutomationTargets: mockGetAdoAutomationTargets,
  };
});

import { TaskPayloadKind } from '@roomote/types';

import { handleAdoPullRequest } from '../handlePullRequest';
import type { AdoPullRequestWebhook } from '../types';

function makePayload(
  eventType: string,
  overrides: Partial<AdoPullRequestWebhook['resource']> = {},
): AdoPullRequestWebhook {
  return {
    id: `delivery-${eventType}`,
    eventType,
    publisherId: 'tfs',
    resourceContainers: {
      account: {
        baseUrl: 'https://dev.azure.com/acme/',
      },
    },
    resource: {
      repository: {
        id: 'repo-1',
        name: 'backend',
        project: {
          id: 'project-1',
          name: 'Platform',
        },
      },
      pullRequestId: 42,
      title: 'Update backend',
      status: 'active',
      sourceRefName: 'refs/heads/feature/test',
      targetRefName: 'refs/heads/main',
      createdBy: {
        uniqueName: 'roomote-bot@acme.example',
      },
      closedBy: {
        uniqueName: 'roomote-bot@acme.example',
      },
      lastMergeSourceCommit: {
        commitId: 'abc123',
      },
      _links: {
        web: {
          href: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
        },
      },
      ...overrides,
    },
  };
}

describe('handleAdoPullRequest', () => {
  beforeEach(() => {
    mockEnqueueTask.mockReset();
    mockGetAdoAutomationTargets.mockReset();
    mockUpdateTaskPrStatus.mockReset();
    mockRepositoriesFindFirst.mockReset();
    mockDedupSelect.mockReset();
    mockScheduleNotifyPullRequestTerminalStatus.mockReset();

    mockRepositoriesFindFirst.mockResolvedValue({ id: 'repo-row-1' });
    mockDedupSelect.mockReturnValue([]);

    mockGetAdoAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'ado:pr_review:repo-1',
          settings: null,
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockEnqueueTask.mockResolvedValue({
      id: 1234,
      taskId: 'task-1',
    });
  });

  it('enqueues Azure DevOps PR review tasks for created pull requests', async () => {
    const result = await handleAdoPullRequest(
      makePayload('git.pullrequest.created'),
    );

    expect(result).toEqual({
      status: 'ok',
      metadata: {
        ids: [1234],
      },
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.GithubPrReview,
          payload: expect.objectContaining({
            repo: 'acme/Platform/backend',
            sourceControlProvider: 'ado',
            prNumber: 42,
            prUrl:
              'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
            headSha: 'abc123',
            branchName: 'feature/test',
            branch: 'feature/test',
            sha: 'abc123',
            targetBranch: 'main',
          }),
        }),
        initiator: expect.objectContaining({
          kind: 'automation',
          key: 'review_code',
          actor: expect.objectContaining({
            displayName: 'roomote-bot@acme.example',
          }),
        }),
        workflow: 'pr_review',
        surface: 'ado',
        trigger: 'webhook',
        prLinkage: expect.objectContaining({
          provider: 'ado',
          repository: 'acme/Platform/backend',
          prNumber: 42,
          prSha: 'abc123',
          prBaseRef: 'main',
        }),
      }),
      expect.objectContaining({
        launchClass: 'automation',
      }),
    );
  });

  it('uses the legacy Visual Studio repository host as the organization fallback', async () => {
    const payload = makePayload('git.pullrequest.created', {
      repository: {
        id: 'repo-1',
        name: 'backend',
        project: {
          id: 'project-1',
          name: 'Platform',
        },
        webUrl: 'https://acme.visualstudio.com/Platform/_git/backend',
      },
      _links: undefined,
    });
    payload.resourceContainers = undefined;

    await handleAdoPullRequest(payload);

    expect(mockGetAdoAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          repositoryFullName: 'acme/Platform/backend',
        }),
      }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/Platform/backend',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('enqueues sync reviews for updated pull requests', async () => {
    await handleAdoPullRequest(makePayload('git.pullrequest.updated'), {
      updatedNotificationType: 'PushNotification',
    });

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.GithubPrReviewSync,
          payload: expect.objectContaining({
            branch: 'feature/test',
            sha: 'abc123',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('skips active status update notifications for updated pull requests', async () => {
    await expect(
      handleAdoPullRequest(makePayload('git.pullrequest.updated'), {
        updatedNotificationType: 'StatusUpdateNotification',
      }),
    ).resolves.toEqual({
      status: 'ok',
      message: 'unsupported_ado_pull_request_event:git.pullrequest.updated',
    });

    expect(mockGetAdoAutomationTargets).not.toHaveBeenCalled();
    expect(mockDedupSelect).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips updated pull requests when the head SHA already has a review job', async () => {
    mockDedupSelect.mockReturnValueOnce([{ id: 99 }]);

    await expect(
      handleAdoPullRequest(makePayload('git.pullrequest.updated'), {
        updatedNotificationType: 'PushNotification',
      }),
    ).resolves.toEqual({
      status: 'ok',
      message: 'Azure DevOps PR head SHA already has a review job.',
    });

    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips legacy updated pull request events without prior review state', async () => {
    await expect(
      handleAdoPullRequest(makePayload('git.pullrequest.updated')),
    ).resolves.toEqual({
      status: 'ok',
      message: 'No prior Azure DevOps PR review found for sync event.',
    });

    expect(mockDedupSelect).toHaveBeenCalledTimes(2);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('enqueues legacy updated pull request events when the head SHA changed', async () => {
    mockDedupSelect.mockReturnValueOnce([]).mockReturnValueOnce([{ id: 98 }]);

    await handleAdoPullRequest(makePayload('git.pullrequest.updated'));

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.GithubPrReviewSync,
          payload: expect.objectContaining({
            branch: 'feature/test',
            sha: 'abc123',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('updates tracked task PR status and notifications for completed pull requests', async () => {
    await expect(
      handleAdoPullRequest(
        makePayload('git.pullrequest.updated', {
          status: 'completed',
          creationDate: '2026-07-01T00:00:00Z',
          closedDate: '2026-07-10T00:00:00Z',
        }),
        { updatedNotificationType: 'StatusUpdateNotification' },
      ),
    ).resolves.toEqual({ status: 'ok' });

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'ado',
      'acme/Platform/backend',
      42,
      'merged',
    );
    expect(mockScheduleSourceControlPullRequestFactSync).toHaveBeenCalledWith({
      provider: 'ado',
      repositoryFullName: 'acme/Platform/backend',
      pullRequest: {
        number: 42,
        title: 'Update backend',
        url: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
        authorLogin: 'roomote-bot@acme.example',
        state: 'merged',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-10T00:00:00Z',
        mergedAt: '2026-07-10T00:00:00Z',
      },
    });
    expect(mockScheduleNotifyPullRequestTerminalStatus).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'ado',
        repository: 'acme/Platform/backend',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl:
          'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
        status: 'merged',
        actorLogin: 'roomote-bot@acme.example',
      },
      'PR #42',
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('does not process stale merge-attempted events as completion updates', async () => {
    await expect(
      handleAdoPullRequest(
        makePayload('git.pullrequest.merged', { status: 'completed' }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      message: 'unsupported_ado_pull_request_event:git.pullrequest.merged',
    });

    expect(mockUpdateTaskPrStatus).not.toHaveBeenCalled();
    expect(mockScheduleNotifyPullRequestTerminalStatus).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('updates tracked task PR status and notifies for abandoned pull requests', async () => {
    await handleAdoPullRequest(
      makePayload('git.pullrequest.updated', { status: 'abandoned' }),
      { updatedNotificationType: 'StatusUpdateNotification' },
    );

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'ado',
      'acme/Platform/backend',
      42,
      'closed',
    );
    expect(mockScheduleNotifyPullRequestTerminalStatus).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'ado',
        repository: 'acme/Platform/backend',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl:
          'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
        status: 'closed',
        actorLogin: 'roomote-bot@acme.example',
      },
      'PR #42',
    );
  });
});

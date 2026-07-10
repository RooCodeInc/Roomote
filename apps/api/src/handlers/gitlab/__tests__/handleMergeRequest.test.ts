const {
  mockEnqueueTask,
  mockGetGitLabAutomationTargets,
  mockUpdateTaskPrStatus,
  mockRepositoriesFindFirst,
  mockNotifySlackPrMerge,
  mockNotifyTeamsPrMerge,
  mockNotifyTelegramAndLinearPrMerge,
  mockFindActiveGitHubPrReviewTask,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetGitLabAutomationTargets: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
  mockRepositoriesFindFirst: vi.fn(),
  mockNotifySlackPrMerge: vi.fn(),
  mockNotifyTeamsPrMerge: vi.fn(),
  mockNotifyTelegramAndLinearPrMerge: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/sdk/server', () => ({
  updateTaskPrStatus: mockUpdateTaskPrStatus,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findFirst: (...args: unknown[]) => mockRepositoriesFindFirst(...args),
      },
    },
  },
  repositories: {
    sourceControlProvider: 'repositories.sourceControlProvider',
    fullName: 'repositories.fullName',
    isActive: 'repositories.isActive',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  findActiveGitHubPrReviewTask: (...args: unknown[]) =>
    mockFindActiveGitHubPrReviewTask(...args),
}));

vi.mock('../../github/notifySlackPrMerge', () => ({
  notifySlackPrMerge: mockNotifySlackPrMerge,
}));

vi.mock('../../github/notifyTeamsPrMerge', () => ({
  notifyTeamsPrMerge: mockNotifyTeamsPrMerge,
}));

vi.mock('../../github/notifyTelegramAndLinearPrMerge', () => ({
  notifyTelegramAndLinearPrMerge: mockNotifyTelegramAndLinearPrMerge,
}));

vi.mock('../getGitLabAutomationTargets', () => ({
  getGitLabAutomationTargets: mockGetGitLabAutomationTargets,
}));

import { TaskPayloadKind } from '@roomote/types';

import { handleGitLabMergeRequest } from '../handleMergeRequest';
import type { GitLabMergeRequestWebhook } from '../types';

function makePayload(
  action: string,
  overrides: Partial<GitLabMergeRequestWebhook['object_attributes']> = {},
): GitLabMergeRequestWebhook {
  return {
    object_kind: 'merge_request',
    event_type: 'merge_request',
    user: { id: 10, username: 'roomote-bot' },
    project: {
      id: 123,
      path_with_namespace: 'acme/backend',
    },
    object_attributes: {
      action,
      id: 999,
      iid: 42,
      title: 'Update backend',
      url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
      source_branch: 'feature/test',
      target_branch: 'main',
      last_commit: { id: 'abc123' },
      ...overrides,
    },
  };
}

describe('handleGitLabMergeRequest', () => {
  beforeEach(() => {
    mockEnqueueTask.mockReset();
    mockGetGitLabAutomationTargets.mockReset();
    mockUpdateTaskPrStatus.mockReset();
    mockRepositoriesFindFirst.mockReset();
    mockNotifySlackPrMerge.mockReset();
    mockNotifyTeamsPrMerge.mockReset();
    mockNotifyTelegramAndLinearPrMerge.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();

    mockRepositoriesFindFirst.mockResolvedValue({ id: 'repo-row-1' });
    mockNotifySlackPrMerge.mockResolvedValue(undefined);
    mockNotifyTeamsPrMerge.mockResolvedValue(undefined);
    mockNotifyTelegramAndLinearPrMerge.mockResolvedValue(undefined);

    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitlab:pr_reviewer:repo-1',
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
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
  });

  it('enqueues GitLab MR review tasks for open merge requests', async () => {
    const result = await handleGitLabMergeRequest(makePayload('open'));

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
            repo: 'acme/backend',
            sourceControlProvider: 'gitlab',
            prNumber: 42,
            prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
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
        }),
        workflow: 'pr_review',
        surface: 'gitlab',
        trigger: 'webhook',
        prLinkage: expect.objectContaining({
          provider: 'gitlab',
          repository: 'acme/backend',
          prNumber: 42,
          prSha: 'abc123',
        }),
      }),
      expect.objectContaining({
        launchClass: 'automation',
      }),
    );
  });

  it('enqueues sync reviews only when GitLab marks an update as code-related', async () => {
    await expect(
      handleGitLabMergeRequest(makePayload('update')),
    ).resolves.toMatchObject({
      status: 'ok',
      message: 'unsupported_merge_request_action:update',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();

    await handleGitLabMergeRequest(makePayload('update', { oldrev: 'oldsha' }));

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

  it('skips enqueuing a sync review when an active review already exists for the head SHA', async () => {
    mockFindActiveGitHubPrReviewTask.mockResolvedValue({
      jobId: 99,
      taskId: 'running-task',
      type: TaskPayloadKind.GithubPrReviewSync,
      status: 'running' as never,
      taskPhase: 'running',
      match: 'github_pr',
    });

    const result = await handleGitLabMergeRequest(
      makePayload('update', { oldrev: 'oldsha' }),
    );

    expect(result).toMatchObject({
      status: 'ok',
      message: 'GitLab MR head SHA already has an active review job.',
    });
    expect(mockFindActiveGitHubPrReviewTask).toHaveBeenCalledWith({
      repoFullName: 'acme/backend',
      prNumber: 42,
      headSha: 'abc123',
      sourceControlProvider: 'gitlab',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('does not run head-SHA dedup for open merge requests', async () => {
    await handleGitLabMergeRequest(makePayload('open'));

    expect(mockFindActiveGitHubPrReviewTask).not.toHaveBeenCalled();
    expect(mockEnqueueTask).toHaveBeenCalled();
  });

  it('updates tracked task PR status for merged merge requests', async () => {
    await expect(
      handleGitLabMergeRequest(makePayload('merge')),
    ).resolves.toEqual({ status: 'ok' });

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitlab',
      'acme/backend',
      42,
      'merged',
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('notifies Slack, Teams, and Telegram/Linear threads for merged merge requests on active synced repositories', async () => {
    await handleGitLabMergeRequest(makePayload('merge'));

    const expectedParams = {
      sourceControlProvider: 'gitlab',
      repository: 'acme/backend',
      prNumber: 42,
      prTitle: 'Update backend',
      prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
      mergedBy: 'roomote-bot',
    };

    expect(mockNotifySlackPrMerge).toHaveBeenCalledWith(expectedParams);
    expect(mockNotifyTeamsPrMerge).toHaveBeenCalledWith(expectedParams);
    expect(mockNotifyTelegramAndLinearPrMerge).toHaveBeenCalledWith({
      ...expectedParams,
      sourceControlProvider: 'gitlab',
    });
  });

  it('does not notify merge threads for closed merge requests', async () => {
    await handleGitLabMergeRequest(makePayload('close'));

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitlab',
      'acme/backend',
      42,
      'closed',
    );
    expect(mockNotifySlackPrMerge).not.toHaveBeenCalled();
    expect(mockNotifyTeamsPrMerge).not.toHaveBeenCalled();
    expect(mockNotifyTelegramAndLinearPrMerge).not.toHaveBeenCalled();
  });

  it('does not notify merge threads when the repository is not an active synced GitLab row', async () => {
    mockRepositoriesFindFirst.mockResolvedValue(undefined);

    await handleGitLabMergeRequest(makePayload('merge'));

    expect(mockNotifySlackPrMerge).not.toHaveBeenCalled();
    expect(mockNotifyTeamsPrMerge).not.toHaveBeenCalled();
    expect(mockNotifyTelegramAndLinearPrMerge).not.toHaveBeenCalled();
  });
});

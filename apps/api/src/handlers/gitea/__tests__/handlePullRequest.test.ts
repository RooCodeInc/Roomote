const {
  mockEnqueueCloudTask,
  mockGetGiteaAutomationTargets,
  mockUpdateTaskPrStatus,
  mockRepositoriesFindFirst,
  mockNotifySlackPrMerge,
  mockNotifyTeamsPrMerge,
  mockNotifyTelegramAndLinearPrMerge,
  mockFindActiveGitHubPrReviewTask,
} = vi.hoisted(() => ({
  mockEnqueueCloudTask: vi.fn(),
  mockGetGiteaAutomationTargets: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
  mockRepositoriesFindFirst: vi.fn(),
  mockNotifySlackPrMerge: vi.fn(),
  mockNotifyTeamsPrMerge: vi.fn(),
  mockNotifyTelegramAndLinearPrMerge: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: mockEnqueueCloudTask,
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

vi.mock('../getGiteaAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getGiteaAutomationTargets')
  >('../getGiteaAutomationTargets');

  return {
    ...actual,
    getGiteaAutomationTargets: mockGetGiteaAutomationTargets,
  };
});

import { CloudTaskType } from '@roomote/types';

import { handleGiteaPullRequest } from '../handlePullRequest';
import type { GiteaPullRequestWebhook } from '../types';

function makePayload(
  action: string,
  overrides: Partial<GiteaPullRequestWebhook['pull_request']> = {},
): GiteaPullRequestWebhook {
  return {
    action,
    number: 42,
    sender: { id: 10, login: 'roomote-bot' },
    repository: {
      id: 123,
      full_name: 'acme/backend',
      html_url: 'https://git.example.com/acme/backend',
    },
    commit_id: 'abc123',
    pull_request: {
      number: 42,
      title: 'Update backend',
      html_url: 'https://git.example.com/acme/backend/pulls/42',
      head: { ref: 'feature/test', sha: 'abc123' },
      base: { ref: 'main' },
      ...overrides,
    },
  };
}

describe('handleGiteaPullRequest', () => {
  beforeEach(() => {
    mockEnqueueCloudTask.mockReset();
    mockGetGiteaAutomationTargets.mockReset();
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

    mockGetGiteaAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_reviewer:repo-1',
          settings: null,
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockEnqueueCloudTask.mockResolvedValue({
      id: 1234,
      taskId: 'task-1',
    });
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
  });

  it('enqueues Gitea PR review tasks for opened pull requests', async () => {
    const result = await handleGiteaPullRequest(makePayload('opened'));

    expect(result).toEqual({
      status: 'ok',
      metadata: {
        ids: [1234],
      },
    });
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        attributionOverride: {
          kind: 'automatic',
          sourceKind: 'gitea',
        },
        type: CloudTaskType.GithubPrReview,
        payload: expect.objectContaining({
          repo: 'acme/backend',
          sourceControlProvider: 'gitea',
          prNumber: 42,
          prUrl: 'https://git.example.com/acme/backend/pulls/42',
          headSha: 'abc123',
          branchName: 'feature/test',
          branch: 'feature/test',
          sha: 'abc123',
          targetBranch: 'main',
        }),
      }),
      expect.objectContaining({
        launchClass: 'automation',
      }),
    );
  });

  it('enqueues sync reviews for synchronized pull requests', async () => {
    await handleGiteaPullRequest(makePayload('synchronized'));

    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.GithubPrReviewSync,
        payload: expect.objectContaining({
          branch: 'feature/test',
          sha: 'abc123',
        }),
      }),
      expect.any(Object),
    );
  });

  it('skips enqueuing a sync review when an active review already exists for the head SHA', async () => {
    mockFindActiveGitHubPrReviewTask.mockResolvedValue({
      jobId: 99,
      taskId: 'running-task',
      type: CloudTaskType.GithubPrReviewSync,
      status: 'running' as never,
      taskPhase: 'running',
      match: 'github_pr',
    });

    const result = await handleGiteaPullRequest(makePayload('synchronized'));

    expect(result).toMatchObject({
      status: 'ok',
      message: 'Gitea PR head SHA already has an active review job.',
    });
    expect(mockFindActiveGitHubPrReviewTask).toHaveBeenCalledWith({
      repoFullName: 'acme/backend',
      prNumber: 42,
      headSha: 'abc123',
      sourceControlProvider: 'gitea',
    });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('does not run head-SHA dedup for opened pull requests', async () => {
    await handleGiteaPullRequest(makePayload('opened'));

    expect(mockFindActiveGitHubPrReviewTask).not.toHaveBeenCalled();
    expect(mockEnqueueCloudTask).toHaveBeenCalled();
  });

  it('updates tracked task PR status and notifications for merged pull requests', async () => {
    await expect(
      handleGiteaPullRequest(makePayload('closed', { merged: true })),
    ).resolves.toEqual({ status: 'ok' });

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitea',
      'acme/backend',
      42,
      'merged',
    );
    expect(mockNotifySlackPrMerge).toHaveBeenCalledWith({
      sourceControlProvider: 'gitea',
      repository: 'acme/backend',
      prNumber: 42,
      prTitle: 'Update backend',
      prUrl: 'https://git.example.com/acme/backend/pulls/42',
      mergedBy: 'roomote-bot',
    });
    expect(mockNotifyTeamsPrMerge).toHaveBeenCalledWith({
      sourceControlProvider: 'gitea',
      repository: 'acme/backend',
      prNumber: 42,
      prTitle: 'Update backend',
      prUrl: 'https://git.example.com/acme/backend/pulls/42',
      mergedBy: 'roomote-bot',
    });
    expect(mockNotifyTelegramAndLinearPrMerge).toHaveBeenCalledWith({
      repository: 'acme/backend',
      prNumber: 42,
      prTitle: 'Update backend',
      prUrl: 'https://git.example.com/acme/backend/pulls/42',
      mergedBy: 'roomote-bot',
      sourceControlProvider: 'gitea',
    });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('updates tracked task PR status without notifications for closed pull requests', async () => {
    await handleGiteaPullRequest(makePayload('closed'));

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitea',
      'acme/backend',
      42,
      'closed',
    );
    expect(mockNotifySlackPrMerge).not.toHaveBeenCalled();
    expect(mockNotifyTeamsPrMerge).not.toHaveBeenCalled();
    expect(mockNotifyTelegramAndLinearPrMerge).not.toHaveBeenCalled();
  });
});

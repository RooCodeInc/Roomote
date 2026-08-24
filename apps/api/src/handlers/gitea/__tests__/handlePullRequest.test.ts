const {
  mockEnqueueTask,
  mockGetGiteaAutomationTargets,
  mockUpdateTaskPrStatus,
  mockRecordPrStatusChangeInTaskHistory,
  mockRepositoriesFindFirst,
  mockScheduleNotifyPullRequestTerminalStatus,
  mockScheduleSourceControlPullRequestFactSync,
  mockFindActiveGitHubPrReviewTask,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetGiteaAutomationTargets: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
  mockRecordPrStatusChangeInTaskHistory: vi.fn(),
  mockRepositoriesFindFirst: vi.fn(),
  mockScheduleNotifyPullRequestTerminalStatus: vi.fn(),
  mockScheduleSourceControlPullRequestFactSync: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
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
        findMany: async (...args: unknown[]) => {
          const row = await mockRepositoriesFindFirst(...args);
          return row ? [row] : [];
        },
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

vi.mock('../../github/notifyPullRequestTerminalStatus', () => ({
  scheduleNotifyPullRequestTerminalStatus:
    mockScheduleNotifyPullRequestTerminalStatus,
}));

vi.mock('../../pull-request-fact-sync', () => ({
  scheduleSourceControlPullRequestFactSync:
    mockScheduleSourceControlPullRequestFactSync,
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

import { TaskPayloadKind } from '@roomote/types';

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
    mockEnqueueTask.mockReset();
    mockGetGiteaAutomationTargets.mockReset();
    mockUpdateTaskPrStatus.mockReset();
    mockRepositoriesFindFirst.mockReset();
    mockScheduleNotifyPullRequestTerminalStatus.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();

    mockRepositoriesFindFirst.mockResolvedValue({
      id: 'repo-row-1',
      host: null,
    });

    mockGetGiteaAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: null },
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

  it('enqueues Gitea PR review tasks for opened pull requests', async () => {
    const result = await handleGiteaPullRequest(makePayload('opened'));

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
        initiator: expect.objectContaining({
          kind: 'automation',
          key: 'review_code',
        }),
        workflow: 'pr_review',
        surface: 'gitea',
        trigger: 'webhook',
        prLinkage: expect.objectContaining({
          provider: 'gitea',
          repository: 'acme/backend',
          prNumber: 42,
          prSha: 'abc123',
        }),
      }),
      expect.objectContaining({
        launchClass: 'automation',
      }),
    );
    // A repository row without a recorded host omits the payload host field
    // entirely so resolution falls back to (provider, fullName).
    const [{ task }] = mockEnqueueTask.mock.calls[0]! as unknown as [
      { task: { payload: Record<string, unknown> } },
    ];
    expect('sourceControlHost' in task.payload).toBe(false);
  });

  it('selects and stamps the webhook host among same-name repositories on multiple hosts', async () => {
    // Two active rows share the repository identity; only the host differs.
    const rows = [
      { id: 'repo-host-a', host: 'gitea.host-a.example' },
      { id: 'repo-host-b', host: 'gitea.host-b.example' },
    ];
    mockGetGiteaAutomationTargets.mockImplementation(
      async ({ webhookHost }: { webhookHost?: string | null }) => {
        const repo = rows.find((row) => row.host === webhookHost);
        return repo
          ? {
              status: 'ok',
              targets: [
                {
                  id: `gitea:pr_review:${repo.id}`,
                  settings: null,
                  repo,
                  repositoryIds: [repo.id],
                  userId: 'user-1',
                },
              ],
            }
          : { status: 'error', message: 'no matching repository row' };
      },
    );

    await handleGiteaPullRequest(
      makePayload('opened', {
        html_url: 'https://gitea.host-a.example/acme/backend/pulls/42',
      }),
    );

    // The handler derives the instance host from the webhook URL...
    expect(mockGetGiteaAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ webhookHost: 'gitea.host-a.example' }),
    );
    // ...and the launched payload pins the matching row's host.
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlHost: 'gitea.host-a.example',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('stamps the repository host into review payloads when the repository row has one', async () => {
    mockGetGiteaAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: 'git.example.com' },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });

    await handleGiteaPullRequest(makePayload('opened'));

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlProvider: 'gitea',
            // Pins repository resolution to the webhook repository's host.
            sourceControlHost: 'git.example.com',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('enqueues sync reviews for synchronized pull requests', async () => {
    await handleGiteaPullRequest(makePayload('synchronized'));

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
      runId: 99,
      taskId: 'running-task',
      type: TaskPayloadKind.GithubPrReviewSync,
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
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('does not run head-SHA dedup for opened pull requests', async () => {
    await handleGiteaPullRequest(makePayload('opened'));

    expect(mockFindActiveGitHubPrReviewTask).not.toHaveBeenCalled();
    expect(mockEnqueueTask).toHaveBeenCalled();
  });

  it('updates tracked task PR status and notifications for merged pull requests', async () => {
    await expect(
      handleGiteaPullRequest(
        makePayload('closed', {
          merged: true,
          id: 900,
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-10T00:00:00Z',
          merged_at: '2026-07-10T00:00:00Z',
          user: { id: 4, login: 'gitea-user' },
        }),
      ),
    ).resolves.toEqual({ status: 'ok' });

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitea',
      'acme/backend',
      42,
      'merged',
    );
    expect(mockScheduleSourceControlPullRequestFactSync).toHaveBeenCalledWith({
      provider: 'gitea',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 42,
        externalId: 900,
        title: 'Update backend',
        body: null,
        url: 'https://git.example.com/acme/backend/pulls/42',
        authorLogin: 'gitea-user',
        state: 'merged',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-10T00:00:00Z',
        mergedAt: '2026-07-10T00:00:00Z',
      },
    });
    expect(mockScheduleNotifyPullRequestTerminalStatus).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'gitea',
        repository: 'acme/backend',
        repositoryId: 'repo-row-1',
        host: 'git.example.com',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl: 'https://git.example.com/acme/backend/pulls/42',
        status: 'merged',
        actorLogin: 'roomote-bot',
      },
      'PR #42',
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('updates tracked task PR status and notifications for closed pull requests', async () => {
    await handleGiteaPullRequest(makePayload('closed'));

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitea',
      'acme/backend',
      42,
      'closed',
    );
    expect(mockScheduleNotifyPullRequestTerminalStatus).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'gitea',
        repository: 'acme/backend',
        repositoryId: 'repo-row-1',
        host: 'git.example.com',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl: 'https://git.example.com/acme/backend/pulls/42',
        status: 'closed',
        actorLogin: 'roomote-bot',
      },
      'PR #42',
    );
  });
});

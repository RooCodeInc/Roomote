const {
  mockEnqueueTask,
  mockGetGitLabAutomationTargets,
  mockUpdateTaskPrStatus,
  mockRecordPrStatusChangeInTaskHistory,
  mockRepositoriesFindFirst,
  mockScheduleNotifyPullRequestTerminalStatus,
  mockScheduleSourceControlPullRequestFactSync,
  mockFindActiveGitHubPrReviewTask,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetGitLabAutomationTargets: vi.fn(),
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
      body: null,
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
    mockScheduleNotifyPullRequestTerminalStatus.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();

    mockRepositoriesFindFirst.mockResolvedValue({
      id: 'repo-row-1',
      host: null,
    });

    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitlab:pr_review:repo-1',
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
    // A repository row without a recorded host omits the payload host field
    // entirely so resolution falls back to (provider, fullName).
    const [{ task }] = mockEnqueueTask.mock.calls[0]! as unknown as [
      { task: { payload: Record<string, unknown> } },
    ];
    expect('sourceControlHost' in task.payload).toBe(false);
  });

  it('restores tracked draft status when a merge request is reopened', async () => {
    await handleGitLabMergeRequest(makePayload('reopen', { draft: true }));

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitlab',
      'acme/backend',
      42,
      'draft',
    );
  });

  it('selects and stamps the webhook host among same-name repositories on multiple hosts', async () => {
    // Two active rows share the repository identity; only the host differs.
    const rows = [
      { id: 'repo-host-a', host: 'gitlab.host-a.example' },
      { id: 'repo-host-b', host: 'gitlab.host-b.example' },
    ];
    mockGetGitLabAutomationTargets.mockImplementation(
      async ({ webhookHost }: { webhookHost?: string | null }) => {
        const repo = rows.find((row) => row.host === webhookHost);
        return repo
          ? {
              status: 'ok',
              targets: [
                {
                  id: `gitlab:pr_review:${repo.id}`,
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

    await handleGitLabMergeRequest(
      makePayload('open', {
        url: 'https://gitlab.host-a.example/acme/backend/-/merge_requests/42',
      }),
    );

    // The handler derives the instance host from the webhook URL...
    expect(mockGetGitLabAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ webhookHost: 'gitlab.host-a.example' }),
    );
    // ...and the launched payload pins the matching row's host.
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlHost: 'gitlab.host-a.example',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('stamps the repository host into review payloads when the repository row has one', async () => {
    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitlab:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: 'gitlab.example.com' },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });

    await handleGitLabMergeRequest(makePayload('open'));

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlProvider: 'gitlab',
            // Pins repository resolution to the webhook repository's host.
            sourceControlHost: 'gitlab.example.com',
          }),
        }),
      }),
      expect.any(Object),
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
      runId: 99,
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
      handleGitLabMergeRequest(
        makePayload('merge', {
          created_at: '2026-07-01 00:00:00 UTC',
          updated_at: '2026-07-10 00:00:00 UTC',
        }),
      ),
    ).resolves.toEqual({ status: 'ok' });

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitlab',
      'acme/backend',
      42,
      'merged',
    );
    expect(mockRecordPrStatusChangeInTaskHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetBranch: 'main' }),
    );
    expect(mockScheduleSourceControlPullRequestFactSync).toHaveBeenCalledWith({
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 42,
        externalId: 999,
        title: 'Update backend',
        body: null,
        url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        authorLogin: null,
        state: 'merged',
        createdAt: '2026-07-01 00:00:00 UTC',
        updatedAt: '2026-07-10 00:00:00 UTC',
      },
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('notifies linked terminal-status surfaces for merged merge requests on active synced repositories', async () => {
    await handleGitLabMergeRequest(makePayload('merge'));

    expect(mockScheduleNotifyPullRequestTerminalStatus).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'gitlab',
        repository: 'acme/backend',
        repositoryId: 'repo-row-1',
        host: 'gitlab.com',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        status: 'merged',
        actorLogin: 'roomote-bot',
      },
      'MR !42',
    );
  });

  it('notifies linked terminal-status surfaces for closed merge requests', async () => {
    await handleGitLabMergeRequest(makePayload('close'));

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitlab',
      'acme/backend',
      42,
      'closed',
    );
    expect(mockScheduleNotifyPullRequestTerminalStatus).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'gitlab',
        repository: 'acme/backend',
        repositoryId: 'repo-row-1',
        host: 'gitlab.com',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        status: 'closed',
        actorLogin: 'roomote-bot',
      },
      'MR !42',
    );
  });

  it('does not notify merge threads when the repository is not an active synced GitLab row', async () => {
    mockRepositoriesFindFirst.mockResolvedValue(undefined);

    await handleGitLabMergeRequest(makePayload('merge'));

    expect(mockScheduleNotifyPullRequestTerminalStatus).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnqueueTask,
  mockGetBitbucketAutomationTargets,
  mockUpdateTaskPrStatus,
  mockRecordPrStatusChangeInTaskHistory,
  mockRepositoriesFindFirst,
  mockScheduleNotifyPullRequestTerminalStatus,
  mockScheduleSourceControlPullRequestFactSync,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetBitbucketAutomationTargets: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
  mockRecordPrStatusChangeInTaskHistory: vi.fn(),
  mockRepositoriesFindFirst: vi.fn(),
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
  },
  repositories: {
    sourceControlProvider: 'repositories.sourceControlProvider',
    fullName: 'repositories.fullName',
    isActive: 'repositories.isActive',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  findActiveGitHubPrReviewTask: vi.fn(),
}));

vi.mock('../../github/notifyPullRequestTerminalStatus', () => ({
  scheduleNotifyPullRequestTerminalStatus:
    mockScheduleNotifyPullRequestTerminalStatus,
}));

vi.mock('../../pull-request-fact-sync', () => ({
  scheduleSourceControlPullRequestFactSync:
    mockScheduleSourceControlPullRequestFactSync,
}));

vi.mock('../getBitbucketAutomationTargets', () => ({
  getBitbucketAutomationTargets: mockGetBitbucketAutomationTargets,
  getBitbucketUsername: (user?: { nickname?: string }) => user?.nickname,
  getBitbucketUserAccountKey: () => null,
}));

import { handleBitbucketPullRequest } from '../handlePullRequest';
import type { BitbucketPullRequestWebhook } from '../types';

function makePayload(
  overrides: Partial<BitbucketPullRequestWebhook['pullrequest']> = {},
): BitbucketPullRequestWebhook {
  return {
    actor: { nickname: 'bb-actor' },
    repository: {
      uuid: '{repo-1}',
      full_name: 'acme/backend',
    },
    pullrequest: {
      id: 42,
      title: 'Update backend',
      state: 'MERGED',
      author: { nickname: 'bb-user' },
      created_on: '2026-07-01T00:00:00Z',
      updated_on: '2026-07-10T00:00:00Z',
      links: {
        html: {
          href: 'https://bitbucket.org/acme/backend/pull-requests/42',
        },
      },
      source: { branch: { name: 'feature/test' }, commit: { hash: 'abc123' } },
      destination: { branch: { name: 'main' } },
      ...overrides,
    },
  };
}

describe('handleBitbucketPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepositoriesFindFirst.mockResolvedValue({ id: 'repo-row-1' });
    mockGetBitbucketAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'bitbucket:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: null },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockEnqueueTask.mockResolvedValue({ id: 1234, taskId: 'task-1' });
  });

  it('enqueues a review without a payload host when the repository row has none', async () => {
    await expect(
      handleBitbucketPullRequest(
        makePayload({ state: 'OPEN' }),
        'pullrequest:created',
      ),
    ).resolves.toEqual({ status: 'ok', metadata: { ids: [1234] } });

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/backend',
            sourceControlProvider: 'bitbucket',
            prNumber: 42,
          }),
        }),
      }),
      expect.objectContaining({ launchClass: 'automation' }),
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
      { id: 'repo-host-a', host: 'bitbucket.host-a.example' },
      { id: 'repo-host-b', host: 'bitbucket.host-b.example' },
    ];
    mockGetBitbucketAutomationTargets.mockImplementation(
      async ({ webhookHost }: { webhookHost?: string | null }) => {
        const repo = rows.find((row) => row.host === webhookHost);
        return repo
          ? {
              status: 'ok',
              targets: [
                {
                  id: `bitbucket:pr_review:${repo.id}`,
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

    await handleBitbucketPullRequest(
      makePayload({
        state: 'OPEN',
        links: {
          html: {
            href: 'https://bitbucket.host-a.example/acme/backend/pull-requests/42',
          },
        },
      }),
      'pullrequest:created',
    );

    // The handler derives the instance host from the webhook URL...
    expect(mockGetBitbucketAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ webhookHost: 'bitbucket.host-a.example' }),
    );
    // ...and the launched payload pins the matching row's host.
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlHost: 'bitbucket.host-a.example',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('stamps the repository host into review payloads when the repository row has one', async () => {
    mockGetBitbucketAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'bitbucket:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: 'bitbucket.example.com' },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });

    await handleBitbucketPullRequest(
      makePayload({ state: 'OPEN' }),
      'pullrequest:created',
    );

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlProvider: 'bitbucket',
            // Pins repository resolution to the webhook repository's host.
            sourceControlHost: 'bitbucket.example.com',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('updates tracked PR status and schedules a fact upsert for merged pull requests', async () => {
    await expect(
      handleBitbucketPullRequest(makePayload(), 'pullrequest:fulfilled'),
    ).resolves.toEqual({ status: 'ok' });

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'bitbucket',
      'acme/backend',
      42,
      'merged',
    );
    expect(mockScheduleSourceControlPullRequestFactSync).toHaveBeenCalledWith({
      provider: 'bitbucket',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 42,
        title: 'Update backend',
        url: 'https://bitbucket.org/acme/backend/pull-requests/42',
        authorLogin: 'bb-user',
        state: 'merged',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-10T00:00:00Z',
      },
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('schedules a closed fact upsert for rejected pull requests', async () => {
    await expect(
      handleBitbucketPullRequest(
        makePayload({ state: 'DECLINED' }),
        'pullrequest:rejected',
      ),
    ).resolves.toEqual({ status: 'ok' });

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'bitbucket',
      'acme/backend',
      42,
      'closed',
    );
    expect(mockScheduleSourceControlPullRequestFactSync).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'bitbucket',
        pullRequest: expect.objectContaining({ state: 'closed' }),
      }),
    );
  });
});

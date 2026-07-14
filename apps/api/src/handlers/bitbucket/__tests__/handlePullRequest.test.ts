import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnqueueTask,
  mockUpdateTaskPrStatus,
  mockRecordPrStatusChangeInTaskHistory,
  mockRepositoriesFindFirst,
  mockScheduleNotifyPullRequestTerminalStatus,
  mockScheduleSourceControlPullRequestFactSync,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
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

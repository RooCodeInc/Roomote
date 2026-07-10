import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const mockFindFirstTaskRun = vi.fn();
const mockFindFirstTaskPullRequest = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockQueueGetJob = vi.fn();
const mockQueueAdd = vi.fn();
const mockPullsGet = vi.fn();
const mockGetCombinedStatusForRef = vi.fn();

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      query: {
        taskRuns: {
          findFirst: (...args: unknown[]) => mockFindFirstTaskRun(...args),
        },
        taskPullRequests: {
          findFirst: (...args: unknown[]) =>
            mockFindFirstTaskPullRequest(...args),
        },
      },
    },
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  }),
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    getJob = (...args: unknown[]) => mockQueueGetJob(...args);
    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

vi.mock('@roomote/github', () => ({
  createTaskRunGitHubToken: vi.fn().mockResolvedValue('github-token'),
  getOctokit: vi.fn().mockReturnValue({
    rest: {
      pulls: {
        get: (...args: unknown[]) => mockPullsGet(...args),
      },
      repos: {
        getCombinedStatusForRef: (...args: unknown[]) =>
          mockGetCombinedStatusForRef(...args),
      },
    },
  }),
}));

import {
  enqueueSlackPrInactivityCheck,
  SLACK_PR_INACTIVITY_DELAY_MS,
} from '../slack-pr-inactivity-check';

type RunWithTask = TaskRun & { task: Record<string, unknown> };

function makeTaskRun(overrides: Partial<RunWithTask> = {}): RunWithTask {
  return {
    id: 1,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.SlackAppMention,
    actingUserId: 'user-1',
    harness: 'opencode-server',
    status: RunStatus.Completed,
    payload: {
      channel: 'C123',
      repo: 'owner/repo',
      user: 'U456',
      text: 'done',
      ts: '111.222',
      thread_ts: '111.222',
    },
    taskId: 'task-1',
    startedAt: null,
    canceledAt: null,
    completedAt: null,
    task: {
      id: 'task-1',
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
      linearSessionId: null,
      linearIssueId: null,
      linearOrganizationId: null,
    },
    ...overrides,
  } as RunWithTask;
}

describe('enqueueSlackPrInactivityCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFindFirstTaskPullRequest.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockQueueGetJob.mockResolvedValue(null);
    mockQueueAdd.mockResolvedValue(undefined);
    mockPullsGet.mockResolvedValue({
      data: {
        head: { sha: 'abc123' },
        state: 'open',
        draft: false,
        merged: false,
        updated_at: '2026-03-10T12:00:00.000Z',
      },
    });
    mockGetCombinedStatusForRef.mockResolvedValue({
      data: { state: 'pending' },
    });
  });

  it('enqueues inactivity reminders for Standard Task Slack jobs', async () => {
    mockFindFirstTaskRun.mockResolvedValue(makeTaskRun());

    const result = await enqueueSlackPrInactivityCheck({
      runId: 1,
      completionText: '[PR #42](https://github.com/owner/repo/pull/42)',
    });

    expect(result).toEqual({
      enqueued: true,
      jobId: 'slack-pr-inactivity-task-1',
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'check-pr-activity',
      expect.objectContaining({
        runId: 1,
        channel: 'C123',
        threadTs: '111.222',
        repository: 'owner/repo',
        prNumber: 42,
      }),
      expect.objectContaining({
        jobId: 'slack-pr-inactivity-task-1',
        delay: SLACK_PR_INACTIVITY_DELAY_MS,
      }),
    );
    expect(mockQueueAdd.mock.calls[0]?.[2]?.jobId).not.toContain(':');
  });

  it('enqueues inactivity reminders for delegated Slack jobs', async () => {
    mockFindFirstTaskRun.mockResolvedValue(makeTaskRun());

    const result = await enqueueSlackPrInactivityCheck({
      runId: 1,
      completionText: '[PR #42](https://github.com/owner/repo/pull/42)',
    });

    expect(result).toEqual({
      enqueued: true,
      jobId: 'slack-pr-inactivity-task-1',
    });
    expect(mockQueueAdd).toHaveBeenCalled();
  });
});

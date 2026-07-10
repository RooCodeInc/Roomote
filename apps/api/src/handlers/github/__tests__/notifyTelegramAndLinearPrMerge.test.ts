// pnpm --filter @roomote/api test src/handlers/github/__tests__/notifyTelegramAndLinearPrMerge.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const {
  mockPostTelegramMessageBestEffort,
  mockLinearEmitResponse,
  mockCreateLinearClient,
  mockFindLinearDeploymentMcpConnection,
  mockGetValidAccessToken,
} = vi.hoisted(() => {
  const mockPostTelegramMessageBestEffort = vi
    .fn()
    .mockResolvedValue({ messageId: 'msg-1' });
  const mockLinearEmitResponse = vi.fn().mockResolvedValue({ success: true });

  return {
    mockPostTelegramMessageBestEffort,
    mockLinearEmitResponse: mockLinearEmitResponse,
    mockCreateLinearClient: vi.fn(() => ({
      emitResponse: mockLinearEmitResponse,
    })),
    mockFindLinearDeploymentMcpConnection: vi.fn(),
    mockGetValidAccessToken: vi.fn(),
  };
});

vi.mock('../../telegram/replies', () => ({
  postTelegramMessageBestEffort: mockPostTelegramMessageBestEffort,
}));

vi.mock('@roomote/linear', () => ({
  createLinearClient: mockCreateLinearClient,
}));

vi.mock('@roomote/sdk/server', () => ({
  findLinearDeploymentMcpConnection: mockFindLinearDeploymentMcpConnection,
  getValidAccessToken: mockGetValidAccessToken,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: vi.fn(),
      },
      taskPullRequests: {
        findMany: vi.fn(),
      },
      taskRuns: {
        findMany: vi.fn(),
      },
      tasks: {
        findMany: vi.fn(),
      },
    },
  },
  taskRuns: {},
  tasks: {},
  githubInstallations: {},
  taskPullRequests: {},
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
}));

import { db } from '@roomote/db/server';
import { notifyTelegramAndLinearPrMerge } from '../notifyTelegramAndLinearPrMerge';

const mockedGithubFind = vi.mocked(db.query.githubInstallations.findFirst);
const mockedTaskPullRequestsFind = vi.mocked(
  db.query.taskPullRequests.findMany,
);
const mockedTaskRunsFind = vi.mocked(db.query.taskRuns.findMany);
const mockedTasksFind = vi.mocked(db.query.tasks.findMany);

const telegramPayload = {
  communicationProvider: 'telegram',
  communicationChannelId: 'chat-1',
  communicationThreadId: 'thread-1',
  communicationMessageId: 'msg-1',
};

describe('notifyTelegramAndLinearPrMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTaskRunsFind.mockResolvedValue([]);
    mockedTasksFind.mockResolvedValue([]);
    mockPostTelegramMessageBestEffort.mockResolvedValue({ messageId: 'msg-1' });
    mockLinearEmitResponse.mockResolvedValue({ success: true });
    mockCreateLinearClient.mockReturnValue({
      emitResponse: mockLinearEmitResponse,
    });
    mockFindLinearDeploymentMcpConnection.mockResolvedValue({ id: 'conn-1' });
    mockGetValidAccessToken.mockResolvedValue('linear-token');
  });

  const baseParams = {
    sourceControlProvider: 'github' as const,
    installationId: 12345,
    repository: 'owner/repo',
    prNumber: 42,
    prTitle: 'Test PR',
    prUrl: 'https://github.com/owner/repo/pull/42',
    mergedBy: 'merger',
  };

  it('posts a markdown merge notification into the Telegram chat', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: telegramPayload }] as any);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockPostTelegramMessageBestEffort).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-1',
      text: '[Test PR](https://github.com/owner/repo/pull/42) was **merged** by merger',
      textFormat: 'markdown',
    });
  });

  it('emits a closing response activity to the linked Linear session', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      { linearSessionId: 'session-1' },
    ] as any);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockLinearEmitResponse).toHaveBeenCalledWith(
      'session-1',
      '[Test PR](https://github.com/owner/repo/pull/42) was **merged** by merger',
    );
  });

  it('notifies both Telegram and Linear from the same merged PR', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: telegramPayload }] as any);
    mockedTasksFind.mockResolvedValue([
      { linearSessionId: 'session-1' },
    ] as any);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockPostTelegramMessageBestEffort).toHaveBeenCalledTimes(1);
    expect(mockLinearEmitResponse).toHaveBeenCalledTimes(1);
  });

  it('skips jobs whose payload is not Telegram-backed', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: { channel: 'C123', thread_ts: 'ts-1' } },
      { payload: null },
    ] as any);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockPostTelegramMessageBestEffort).not.toHaveBeenCalled();
    expect(mockLinearEmitResponse).not.toHaveBeenCalled();
  });

  it('skips Telegram payloads that are missing a chat id', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: { communicationProvider: 'telegram' } },
    ] as any);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockPostTelegramMessageBestEffort).not.toHaveBeenCalled();
  });

  it('deduplicates Telegram notifications for the same chat and thread', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: telegramPayload },
      { payload: telegramPayload },
    ] as any);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockPostTelegramMessageBestEffort).toHaveBeenCalledTimes(1);
  });

  it('deduplicates Linear notifications for the same session', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ] as any);
    mockedTasksFind.mockResolvedValue([
      { linearSessionId: 'session-1' },
      { linearSessionId: 'session-1' },
    ] as any);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockLinearEmitResponse).toHaveBeenCalledTimes(1);
  });

  it('skips Linear when no active connection is available', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      { linearSessionId: 'session-1' },
    ] as any);
    mockFindLinearDeploymentMcpConnection.mockResolvedValue(null);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockLinearEmitResponse).not.toHaveBeenCalled();
  });

  it('does not send notifications when no GitHub installation is found', async () => {
    mockedGithubFind.mockResolvedValue(undefined);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockPostTelegramMessageBestEffort).not.toHaveBeenCalled();
    expect(mockLinearEmitResponse).not.toHaveBeenCalled();
  });

  it('does not send notifications when no linked tasks are found for the PR', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([] as any);

    await notifyTelegramAndLinearPrMerge(baseParams);

    expect(mockedTaskRunsFind).not.toHaveBeenCalled();
    expect(mockedTasksFind).not.toHaveBeenCalled();
    expect(mockPostTelegramMessageBestEffort).not.toHaveBeenCalled();
    expect(mockLinearEmitResponse).not.toHaveBeenCalled();
  });

  it('does not throw when posting to Telegram fails', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: telegramPayload }] as any);
    mockPostTelegramMessageBestEffort.mockRejectedValue(
      new Error('Telegram down'),
    );

    await expect(
      notifyTelegramAndLinearPrMerge(baseParams),
    ).resolves.toBeUndefined();
  });

  it('does not throw when emitting to Linear returns a failure result', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      { linearSessionId: 'session-1' },
    ] as any);
    mockLinearEmitResponse.mockResolvedValue({
      success: false,
      error: 'Linear API error',
    });

    await expect(
      notifyTelegramAndLinearPrMerge(baseParams),
    ).resolves.toBeUndefined();
  });

  it('does not throw when emitting to Linear rejects', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      { linearSessionId: 'session-1' },
    ] as any);
    mockLinearEmitResponse.mockRejectedValue(new Error('Linear down'));

    await expect(
      notifyTelegramAndLinearPrMerge(baseParams),
    ).resolves.toBeUndefined();
  });

  it('works without an installation gate (non-GitHub providers)', async () => {
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: telegramPayload }] as any);

    await notifyTelegramAndLinearPrMerge({
      ...baseParams,
      installationId: undefined,
    });

    expect(mockedGithubFind).not.toHaveBeenCalled();
    expect(mockPostTelegramMessageBestEffort).toHaveBeenCalledTimes(1);
  });
});

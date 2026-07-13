/* eslint-disable @typescript-eslint/no-explicit-any */

const { mockPostMessage, mockResolveDiscordRuntimeCredentials } = vi.hoisted(
  () => ({
    mockPostMessage: vi.fn(),
    mockResolveDiscordRuntimeCredentials: vi.fn(),
  }),
);

vi.mock('@roomote/communication/discord-provider', () => ({
  DiscordCommunicationProvider: vi.fn(function DiscordCommunicationProvider() {
    return { postMessage: mockPostMessage };
  }),
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
    },
  },
  taskRuns: {},
  githubInstallations: {},
  taskPullRequests: {},
  resolveDiscordRuntimeCredentials: mockResolveDiscordRuntimeCredentials,
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { db } from '@roomote/db/server';

import { notifyDiscordPrMerge } from '../notifyDiscordPrMerge';

const mockedGithubFind = vi.mocked(db.query.githubInstallations.findFirst);
const mockedTaskPullRequestsFind = vi.mocked(
  db.query.taskPullRequests.findMany,
);
const mockedTaskRunsFind = vi.mocked(db.query.taskRuns.findMany);

const discordPayload = {
  communicationProvider: 'discord',
  communicationGuildId: 'guild-1',
  communicationChannelId: 'channel-1',
  communicationThreadId: 'thread-1',
};

describe('notifyDiscordPrMerge', () => {
  const baseParams = {
    sourceControlProvider: 'github' as const,
    installationId: 12345,
    repository: 'owner/repo',
    prNumber: 42,
    prTitle: 'Test PR',
    prUrl: 'https://github.com/owner/repo/pull/42',
    mergedBy: 'merger',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-1',
    });
    mockResolveDiscordRuntimeCredentials.mockResolvedValue({
      botToken: 'discord-token',
      applicationId: 'application-1',
    });
  });

  it('posts the merge notification directly into the Discord task thread', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: discordPayload }] as any);

    await notifyDiscordPrMerge(baseParams);

    expect(DiscordCommunicationProvider).toHaveBeenCalledWith({
      botToken: 'discord-token',
      applicationId: 'application-1',
    });
    expect(mockPostMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      text: '[Test PR](https://github.com/owner/repo/pull/42) was **merged** by merger',
      textFormat: 'markdown',
    });
    expect(mockPostMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      'replyToMessageId',
    );
  });

  it('posts to a Discord DM or channel when there is no task thread', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      {
        payload: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
        },
      },
    ] as any);

    await notifyDiscordPrMerge(baseParams);

    expect(mockPostMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      text: expect.any(String),
      textFormat: 'markdown',
    });
  });

  it('deduplicates notifications for the same Discord conversation and thread', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: discordPayload },
      { payload: discordPayload },
    ] as any);

    await notifyDiscordPrMerge(baseParams);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('continues notifying other conversations when one Discord post fails', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: discordPayload },
      {
        payload: {
          ...discordPayload,
          communicationThreadId: 'thread-2',
        },
      },
    ] as any);
    mockPostMessage
      .mockRejectedValueOnce(new Error('Discord is down'))
      .mockResolvedValueOnce({ messageId: 'message-2' });

    await expect(notifyDiscordPrMerge(baseParams)).resolves.toBeUndefined();

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
  });

  it('skips runs whose payload is not Discord-backed or has no channel', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: { communicationProvider: 'telegram' } },
      { payload: { communicationProvider: 'discord' } },
      { payload: null },
    ] as any);

    await notifyDiscordPrMerge(baseParams);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips posting when Discord credentials are not configured', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: discordPayload }] as any);
    mockResolveDiscordRuntimeCredentials.mockResolvedValue({
      botToken: null,
      applicationId: null,
    });

    await notifyDiscordPrMerge(baseParams);

    expect(DiscordCommunicationProvider).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('does not send notifications when no GitHub installation is found', async () => {
    mockedGithubFind.mockResolvedValue(undefined);

    await notifyDiscordPrMerge(baseParams);

    expect(mockedTaskPullRequestsFind).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('does not send notifications when the PR has no linked tasks', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([] as any);

    await notifyDiscordPrMerge(baseParams);

    expect(mockedTaskRunsFind).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('works without an installation gate for other source-control providers', async () => {
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: discordPayload }] as any);

    await notifyDiscordPrMerge({
      ...baseParams,
      sourceControlProvider: 'gitlab',
      installationId: undefined,
    });

    expect(mockedGithubFind).not.toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });
});

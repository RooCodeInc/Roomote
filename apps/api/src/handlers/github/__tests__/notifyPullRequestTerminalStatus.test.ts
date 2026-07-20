// pnpm --filter @roomote/api test src/handlers/github/__tests__/notifyPullRequestTerminalStatus.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const {
  mockPostMessage,
  mockAddReaction,
  mockRemoveReaction,
  mockResolveSlackReactionNames,
  mockStickyFooterPost,
  mockGetCommunicationProviderAdapter,
  mockLinearEmitResponse,
  mockCreateLinearClient,
  mockFindLinearDeploymentMcpConnection,
  mockGetValidAccessToken,
} = vi.hoisted(() => {
  const mockPostMessage = vi.fn().mockResolvedValue({
    channelId: 'conversation-1',
    messageId: 'activity-1',
  });
  const mockLinearEmitResponse = vi.fn().mockResolvedValue({ success: true });

  return {
    mockPostMessage,
    mockAddReaction: vi.fn().mockResolvedValue(true),
    mockRemoveReaction: vi.fn().mockResolvedValue(true),
    mockResolveSlackReactionNames: vi.fn().mockResolvedValue({
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    }),
    mockStickyFooterPost: vi.fn().mockResolvedValue('msg-ts-123'),
    mockGetCommunicationProviderAdapter: vi.fn(),
    mockLinearEmitResponse,
    mockCreateLinearClient: vi.fn(() => ({
      emitResponse: mockLinearEmitResponse,
    })),
    mockFindLinearDeploymentMcpConnection: vi.fn(),
    mockGetValidAccessToken: vi.fn(),
  };
});

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn().mockImplementation(function () {
    return {
      postMessage: mockPostMessage,
      addReaction: mockAddReaction,
      removeReaction: mockRemoveReaction,
    };
  }),
  resolveSlackReactionNames: mockResolveSlackReactionNames,
  postSlackThreadMessageWithStickyFooter: mockStickyFooterPost,
}));

vi.mock('@roomote/linear', () => ({
  createLinearClient: mockCreateLinearClient,
}));

vi.mock('@roomote/sdk/server', () => ({
  getCommunicationProviderAdapter: mockGetCommunicationProviderAdapter,
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
      tasks: {
        findMany: vi.fn(),
      },
      taskRuns: {
        findMany: vi.fn(),
      },
      slackInstallations: {
        findFirst: vi.fn(),
      },
    },
  },
  tasks: {},
  taskRuns: {},
  slackInstallations: {},
  githubInstallations: {},
  taskPullRequests: {},
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  isNotNull: vi.fn((column: unknown) => ({ isNotNull: column })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  like: vi.fn((...args: unknown[]) => ({ like: args })),
}));

import { db } from '@roomote/db/server';
import {
  notifyPullRequestTerminalStatus,
  SLACK_PR_CLOSED_REACTION_EMOJI,
} from '../notifyPullRequestTerminalStatus';

const mockedGithubFind = vi.mocked(db.query.githubInstallations.findFirst);
const mockedTaskPullRequestsFind = vi.mocked(
  db.query.taskPullRequests.findMany,
);
const mockedTasksFind = vi.mocked(db.query.tasks.findMany);
const mockedTaskRunsFind = vi.mocked(db.query.taskRuns.findMany);
const mockedSlackFind = vi.mocked(db.query.slackInstallations.findFirst);

const teamsPayload = {
  communicationProvider: 'teams',
  communicationChannelId: 'conversation-1',
  communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
  communicationThreadId: 'thread-1',
};

const telegramPayload = {
  communicationProvider: 'telegram',
  communicationChannelId: 'chat-1',
  communicationThreadId: 'thread-1',
  communicationMessageId: 'msg-1',
};

const discordPayload = {
  communicationProvider: 'discord',
  communicationChannelId: 'channel-1',
  communicationThreadId: 'discord-thread-1',
  discordReactionChannelId: 'channel-1',
  discordReactionMessageId: 'origin-msg-1',
  discordTaskThread: true,
};

const teamsAdapter = {
  postMessage: mockPostMessage,
};

const telegramAdapter = {
  postMessage: mockPostMessage,
};

const discordAdapter = {
  postMessage: mockPostMessage,
  addReaction: mockAddReaction,
  removeReaction: mockRemoveReaction,
};

const baseParams = {
  sourceControlProvider: 'github' as const,
  installationId: 12345,
  repository: 'owner/repo',
  prNumber: 42,
  prTitle: 'Test PR',
  prUrl: 'https://github.com/owner/repo/pull/42',
  actorLogin: 'merger',
};

describe('notifyPullRequestTerminalStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSlackReactionNames.mockResolvedValue({
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });
    mockStickyFooterPost.mockResolvedValue('msg-ts-123');
    mockPostMessage.mockResolvedValue({
      channelId: 'conversation-1',
      messageId: 'activity-1',
    });
    mockLinearEmitResponse.mockResolvedValue({ success: true });
    mockCreateLinearClient.mockReturnValue({
      emitResponse: mockLinearEmitResponse,
    });
    mockFindLinearDeploymentMcpConnection.mockResolvedValue({ id: 'conn-1' });
    mockGetValidAccessToken.mockResolvedValue('linear-token');
    mockedTaskRunsFind.mockResolvedValue([]);
    mockedTasksFind.mockResolvedValue([]);
    mockGetCommunicationProviderAdapter.mockImplementation(
      async (provider: string) => {
        if (provider === 'teams') return teamsAdapter;
        if (provider === 'telegram') return telegramAdapter;
        if (provider === 'discord') return discordAdapter;
        return null;
      },
    );
  });

  it('posts a sticky-footer Slack message and terminal reaction on merge', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
        linearSessionId: null,
      },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        threadTs: 'thread-ts-1',
        taskId: 'task-1',
        text: 'Test PR was merged by merger',
      }),
    );
    expect(mockAddReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'thread-ts-1',
      name: 'white_check_mark',
    });
    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'thread-ts-1',
      name: 'eyes',
    });
  });

  it('posts a sticky-footer closed message and closed reaction', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
        linearSessionId: null,
      },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);

    await notifyPullRequestTerminalStatus({
      ...baseParams,
      status: 'closed',
      actorLogin: 'closer',
    });

    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Test PR was closed by closer',
      }),
    );
    expect(mockAddReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'thread-ts-1',
      name: SLACK_PR_CLOSED_REACTION_EMOJI,
    });
    expect(SLACK_PR_CLOSED_REACTION_EMOJI).toBe('-1');
  });

  it('posts Teams, Telegram, and Discord via the shared communication adapter', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: teamsPayload },
      { payload: telegramPayload },
      { payload: discordPayload },
    ] as any);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockGetCommunicationProviderAdapter).toHaveBeenCalledWith('teams');
    expect(mockGetCommunicationProviderAdapter).toHaveBeenCalledWith(
      'telegram',
    );
    expect(mockGetCommunicationProviderAdapter).toHaveBeenCalledWith('discord');
    expect(mockPostMessage).toHaveBeenCalledWith({
      channelId: 'conversation-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      threadId: 'thread-1',
      replyToMessageId: 'thread-1',
      text: '[Test PR](https://github.com/owner/repo/pull/42) was **merged** by merger',
      textFormat: 'markdown',
    });
    expect(mockPostMessage).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-1',
      text: '[Test PR](https://github.com/owner/repo/pull/42) was **merged** by merger',
      textFormat: 'markdown',
    });
    expect(mockPostMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'discord-thread-1',
      text: '[Test PR](https://github.com/owner/repo/pull/42) was **merged** by merger',
      textFormat: 'markdown',
    });
    expect(mockAddReaction).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'origin-msg-1',
      name: 'white_check_mark',
    });
    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'origin-msg-1',
      name: 'eyes',
    });
  });

  it('still places Discord merge checkmark when eyes cleanup fails', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: discordPayload }] as any);
    mockRemoveReaction.mockRejectedValueOnce(new Error('already gone'));

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockAddReaction).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'origin-msg-1',
      name: 'white_check_mark',
    });
  });

  it('falls back to Discord communication message for terminal reactions', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      {
        payload: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-9',
          communicationThreadId: 'thread-9',
          communicationMessageId: 'origin-fallback',
        },
      },
    ] as any);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockAddReaction).toHaveBeenCalledWith({
      channelId: 'thread-9',
      messageId: 'origin-fallback',
      name: 'white_check_mark',
    });
  });

  it('emits a Linear closing response activity', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: null,
        slackChannelId: null,
        linearSessionId: 'session-1',
      },
    ] as any);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockLinearEmitResponse).toHaveBeenCalledWith(
      'session-1',
      '[Test PR](https://github.com/owner/repo/pull/42) was **merged** by merger',
    );
  });

  it('resolves linked tasks once and fans out across surfaces', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
        linearSessionId: 'session-1',
      },
    ] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: teamsPayload },
      { payload: telegramPayload },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockedGithubFind).toHaveBeenCalledTimes(1);
    expect(mockedTaskPullRequestsFind).toHaveBeenCalledTimes(1);
    expect(mockedTasksFind).toHaveBeenCalledTimes(1);
    expect(mockedTaskRunsFind).toHaveBeenCalledTimes(1);
    expect(mockStickyFooterPost).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockLinearEmitResponse).toHaveBeenCalledTimes(1);
  });

  it('deduplicates Slack, Teams, Telegram, and Linear deliveries', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
        linearSessionId: 'session-1',
      },
      {
        id: 'task-2',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
        linearSessionId: 'session-1',
      },
    ] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: teamsPayload },
      { payload: teamsPayload },
      { payload: telegramPayload },
      { payload: telegramPayload },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockStickyFooterPost).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockLinearEmitResponse).toHaveBeenCalledTimes(1);
  });

  it('supports Teams alias payload fields from snapshot resume payloads', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      {
        payload: {
          teamsConversationId: 'conversation-2',
          teamsServiceUrl: 'https://smba.trafficmanager.net/emea/',
          teamsThreadId: 'thread-2',
        },
      },
    ] as any);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'conversation-2',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        threadId: 'thread-2',
      }),
    );
  });

  it('does not notify when no GitHub installation is found', async () => {
    mockedGithubFind.mockResolvedValue(undefined);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockedTaskPullRequestsFind).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockLinearEmitResponse).not.toHaveBeenCalled();
  });

  it('does not notify when no linked tasks are found', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([] as any);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockedTasksFind).not.toHaveBeenCalled();
    expect(mockedTaskRunsFind).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips Teams and Telegram when the adapter is not configured', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: teamsPayload },
      { payload: telegramPayload },
    ] as any);
    mockGetCommunicationProviderAdapter.mockResolvedValue(null);

    await notifyPullRequestTerminalStatus(baseParams);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('works without an installation gate for non-GitHub providers', async () => {
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: telegramPayload }] as any);

    await notifyPullRequestTerminalStatus({
      ...baseParams,
      sourceControlProvider: 'gitlab',
      installationId: undefined,
    });

    expect(mockedGithubFind).not.toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('scopes task-PR lookup by repositoryId when provided', async () => {
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: telegramPayload }] as any);

    await notifyPullRequestTerminalStatus({
      ...baseParams,
      sourceControlProvider: 'gitea',
      installationId: undefined,
      repositoryId: 'repo-row-1',
      host: 'gitea.host-a.example',
    });

    // findMany receives the and() of provider/pr/repositoryId scopes.
    expect(mockedTaskPullRequestsFind).toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('does not throw when surface delivery fails', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
        linearSessionId: 'session-1',
      },
    ] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: teamsPayload },
      { payload: telegramPayload },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);
    mockStickyFooterPost.mockRejectedValue(new Error('Slack is down'));
    mockPostMessage.mockRejectedValue(new Error('adapter is down'));
    mockLinearEmitResponse.mockRejectedValue(new Error('Linear down'));

    await expect(
      notifyPullRequestTerminalStatus(baseParams),
    ).resolves.toBeUndefined();
  });
});

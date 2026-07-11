// pnpm --filter @roomote/api test src/handlers/github/__tests__/notifyTeamsPrMerge.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const { mockPostMessage, mockCreateTeamsCommunicationProviderFromEnv } =
  vi.hoisted(() => {
    const mockPostMessage = vi.fn().mockResolvedValue({
      channelId: 'conversation-1',
      messageId: 'activity-1',
    });

    return {
      mockPostMessage,
      mockCreateTeamsCommunicationProviderFromEnv: vi.fn(() => ({
        postMessage: mockPostMessage,
      })),
    };
  });

vi.mock('@roomote/sdk/server', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials:
    mockCreateTeamsCommunicationProviderFromEnv,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    R_TEAMS_BOT_APP_ID: 'teams-app-id',
    R_TEAMS_BOT_APP_PASSWORD: 'teams-app-password',
  },
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
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

import { db } from '@roomote/db/server';
import { notifyTeamsPrMerge } from '../notifyTeamsPrMerge';

const mockedGithubFind = vi.mocked(db.query.githubInstallations.findFirst);
const mockedTaskPullRequestsFind = vi.mocked(
  db.query.taskPullRequests.findMany,
);
const mockedTaskRunsFind = vi.mocked(db.query.taskRuns.findMany);

const teamsPayload = {
  communicationProvider: 'teams',
  communicationChannelId: 'conversation-1',
  communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
  communicationThreadId: 'thread-1',
};

describe('notifyTeamsPrMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTeamsCommunicationProviderFromEnv.mockReturnValue({
      postMessage: mockPostMessage,
    });
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

  it('posts a markdown merge notification into the Teams thread', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: teamsPayload }] as any);

    await notifyTeamsPrMerge(baseParams);

    expect(mockPostMessage).toHaveBeenCalledWith({
      channelId: 'conversation-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      threadId: 'thread-1',
      replyToMessageId: 'thread-1',
      text: '[Test PR](https://github.com/owner/repo/pull/42) was **merged** by merger',
      textFormat: 'markdown',
    });
  });

  it('skips jobs whose payload is not Teams-backed', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: { channel: 'C123', thread_ts: 'ts-1' } },
      { payload: null },
    ] as any);

    await notifyTeamsPrMerge(baseParams);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips Teams payloads that are missing conversation metadata', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([
      {
        payload: {
          communicationProvider: 'teams',
          communicationChannelId: 'conversation-1',
        },
      },
    ] as any);

    await notifyTeamsPrMerge(baseParams);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('deduplicates notifications for the same conversation and thread', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ] as any);
    mockedTaskRunsFind.mockResolvedValue([
      { payload: teamsPayload },
      { payload: teamsPayload },
    ] as any);

    await notifyTeamsPrMerge(baseParams);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('does not send notifications when no GitHub installation is found', async () => {
    mockedGithubFind.mockResolvedValue(undefined);

    await notifyTeamsPrMerge(baseParams);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('does not send notifications when no linked tasks are found for the PR', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([] as any);

    await notifyTeamsPrMerge(baseParams);

    expect(mockedTaskRunsFind).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips posting when Teams bot credentials are not configured', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: teamsPayload }] as any);
    mockCreateTeamsCommunicationProviderFromEnv.mockReturnValue(null as any);

    await notifyTeamsPrMerge(baseParams);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('does not throw when posting to Teams fails', async () => {
    mockedGithubFind.mockResolvedValue({ id: 1 } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTaskRunsFind.mockResolvedValue([{ payload: teamsPayload }] as any);
    mockPostMessage.mockRejectedValue(new Error('Teams is down'));

    await expect(notifyTeamsPrMerge(baseParams)).resolves.toBeUndefined();
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

    await notifyTeamsPrMerge(baseParams);

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'conversation-2',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        threadId: 'thread-2',
      }),
    );
  });
});

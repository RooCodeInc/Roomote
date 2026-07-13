// pnpm --filter @roomote/api test src/handlers/github/__tests__/notifySlackPrMerge.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const {
  mockPostMessage,
  mockAddReaction,
  mockRemoveReaction,
  mockResolveSlackReactionNames,
  mockStickyFooterPost,
} = vi.hoisted(() => ({
  mockPostMessage: vi.fn().mockResolvedValue('msg-ts-123'),
  mockAddReaction: vi.fn().mockResolvedValue(true),
  mockRemoveReaction: vi.fn().mockResolvedValue(true),
  mockResolveSlackReactionNames: vi.fn().mockResolvedValue({
    ackEmoji: 'eyes',
    completionEmoji: 'white_check_mark',
    summonEmoji: null,
  }),
  mockStickyFooterPost: vi.fn().mockResolvedValue('msg-ts-123'),
}));

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
      slackInstallations: {
        findFirst: vi.fn(),
      },
    },
  },
  tasks: {},
  slackInstallations: {},
  githubInstallations: {},
  taskPullRequests: {},
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
}));

import { db } from '@roomote/db/server';
import {
  notifySlackPrMerge,
  SLACK_PR_CLOSED_REACTION_EMOJI,
} from '../notifySlackPrMerge';

const mockedGithubFind = vi.mocked(db.query.githubInstallations.findFirst);
const mockedTaskPullRequestsFind = vi.mocked(
  db.query.taskPullRequests.findMany,
);
const mockedTasksFind = vi.mocked(db.query.tasks.findMany);
const mockedSlackFind = vi.mocked(db.query.slackInstallations.findFirst);

describe('notifySlackPrMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSlackReactionNames.mockResolvedValue({
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
      summonEmoji: null,
    });
    mockStickyFooterPost.mockResolvedValue('msg-ts-123');
  });

  const baseParams = {
    sourceControlProvider: 'github' as const,
    installationId: 12345,
    repository: 'owner/repo',
    prNumber: 42,
    prTitle: 'Test PR',
    prUrl: 'https://github.com/owner/repo/pull/42',
    actorLogin: 'merger',
  };

  it('posts a sticky-footer thread message and adds a white_check_mark reaction to the originating message', async () => {
    mockedGithubFind.mockResolvedValue({ orgId: 'org-1' } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
      },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);

    await notifySlackPrMerge(baseParams);

    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        threadTs: 'thread-ts-1',
        taskId: 'task-1',
        text: 'Test PR was merged by merger',
      }),
    );

    // Should add white_check_mark reaction to originating message
    expect(mockAddReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'thread-ts-1',
      name: 'white_check_mark',
    });

    // Should remove eyes reaction from originating message
    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'thread-ts-1',
      name: 'eyes',
    });
  });

  it('posts a sticky-footer closed message and adds heavy_multiplication_x on close', async () => {
    mockedGithubFind.mockResolvedValue({ orgId: 'org-1' } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
      },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);

    await notifySlackPrMerge({
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
    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'thread-ts-1',
      name: 'eyes',
    });
  });

  it('uses the configured acknowledgement and completion emoji names', async () => {
    mockedGithubFind.mockResolvedValue({ orgId: 'org-1' } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
      },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);
    mockResolveSlackReactionNames.mockResolvedValueOnce({
      ackEmoji: 'hourglass',
      completionEmoji: 'rocket',
      summonEmoji: 'shipit',
    });

    await notifySlackPrMerge(baseParams);

    expect(mockAddReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'thread-ts-1',
      name: 'rocket',
    });
    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'thread-ts-1',
      name: 'hourglass',
    });
  });

  it('uses the slack channel bound on the task row', async () => {
    mockedGithubFind.mockResolvedValue({ orgId: 'org-1' } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C999',
      },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);

    await notifySlackPrMerge(baseParams);

    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C999',
        threadTs: 'thread-ts-1',
      }),
    );
    expect(mockAddReaction).toHaveBeenCalledWith({
      channel: 'C999',
      timestamp: 'thread-ts-1',
      name: 'white_check_mark',
    });
    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C999',
      timestamp: 'thread-ts-1',
      name: 'eyes',
    });
  });

  it('does not send notifications when no GitHub installation is found', async () => {
    mockedGithubFind.mockResolvedValue(undefined);

    await notifySlackPrMerge(baseParams);

    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockAddReaction).not.toHaveBeenCalled();
    expect(mockRemoveReaction).not.toHaveBeenCalled();
  });

  it('does not send notifications when no linked tasks are found for the PR', async () => {
    mockedGithubFind.mockResolvedValue({ orgId: 'org-1' } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([] as any);

    await notifySlackPrMerge(baseParams);

    expect(mockedTasksFind).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockAddReaction).not.toHaveBeenCalled();
    expect(mockRemoveReaction).not.toHaveBeenCalled();
  });

  it('does not send notifications when no tasks with Slack threads are found', async () => {
    mockedGithubFind.mockResolvedValue({ orgId: 'org-1' } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([]);

    await notifySlackPrMerge(baseParams);

    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockAddReaction).not.toHaveBeenCalled();
    expect(mockRemoveReaction).not.toHaveBeenCalled();
  });

  it('skips threads that have already been notified (deduplication)', async () => {
    mockedGithubFind.mockResolvedValue({ orgId: 'org-1' } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
      },
      {
        id: 'task-2',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
      },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);

    await notifySlackPrMerge(baseParams);

    // Should only post once and react once despite two tasks with same thread
    expect(mockStickyFooterPost).toHaveBeenCalledTimes(1);
    expect(mockAddReaction).toHaveBeenCalledTimes(1);
    expect(mockRemoveReaction).toHaveBeenCalledTimes(1);
  });

  it('continues posting even if addReaction fails', async () => {
    mockedGithubFind.mockResolvedValue({ orgId: 'org-1' } as any);
    mockedTaskPullRequestsFind.mockResolvedValue([{ taskId: 'task-1' }] as any);
    mockedTasksFind.mockResolvedValue([
      {
        id: 'task-1',
        slackThreadTs: 'thread-ts-1',
        slackChannelId: 'C123',
      },
    ] as any);
    mockedSlackFind.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    } as any);
    mockAddReaction.mockRejectedValue(new Error('reaction failed'));

    // Should not throw
    await expect(notifySlackPrMerge(baseParams)).resolves.toBeUndefined();

    expect(mockStickyFooterPost).toHaveBeenCalledTimes(1);
  });
});

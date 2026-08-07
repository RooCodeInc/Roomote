import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createTaskThreadMock,
  postMessageMock,
  findDestinationMock,
  insertMock,
  insertValuesMock,
  resolveProviderMock,
  selectLimitMock,
} = vi.hoisted(() => ({
  createTaskThreadMock: vi.fn(),
  postMessageMock: vi.fn(),
  findDestinationMock: vi.fn(),
  insertMock: vi.fn(),
  insertValuesMock: vi.fn(),
  resolveProviderMock: vi.fn(),
  selectLimitMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...values: unknown[]) => values),
  eq: vi.fn((...values: unknown[]) => values),
  sql: vi.fn(),
  trackedMessages: {
    id: 'id',
    metadata: 'metadata',
    kind: 'kind',
    dedupeKey: 'dedupeKey',
  },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimitMock })),
      })),
    })),
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  findDiscordAutomationDestination: vi.fn(async () => null),
  findDiscordDefaultDestination: findDestinationMock,
}));

vi.mock('../../tasks/background-automation-slack.js', () => ({
  resolveScheduledSuggestionSlackConfig: vi.fn(() => ({
    automationKey: 'suggested_tasks',
    suggestionType: 'suggested_tasks',
    actionFooterText: 'Choose one.',
  })),
}));

vi.mock('../../tasks/scheduled-suggestion-root-summary.js', () => ({
  buildScheduledSuggestionRootMessage: vi.fn(async () => ({
    summaryText: 'Here are a few useful tasks.',
  })),
}));

vi.mock('../../tasks/communication-task-thread.js', () => ({
  buildCommunicationTaskThreadName: vi.fn((value: string) => value),
}));

vi.mock('../provider.js', () => ({
  resolveDiscordProvider: resolveProviderMock,
}));

import {
  postCurrentThreadSuggestionsToDiscord,
  postScheduledSuggestionsToDiscord,
} from '../automation-suggestions';

describe('Discord scheduled suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimitMock.mockResolvedValue([]);
    findDestinationMock.mockResolvedValue({
      guildId: 'guild-1',
      channelId: 'channel-1',
      channelType: 15,
    });
    createTaskThreadMock.mockResolvedValue({
      channelId: 'forum-post-1',
      parentChannelId: 'channel-1',
      messageId: 'message-1',
      kind: 'forum_post',
      name: 'Suggested tasks',
    });
    resolveProviderMock.mockResolvedValue({
      provider: {
        createTaskThread: createTaskThreadMock,
        postMessage: postMessageMock,
      },
    });
    postMessageMock.mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-2',
    });
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    });
    insertMock.mockReturnValue({ values: insertValuesMock });
  });

  it('creates a forum post and persists one tracked launch card per idea', async () => {
    const delivered = await postScheduledSuggestionsToDiscord({
      sourceTaskId: 'scan-1',
      createdByUserId: null,
      suggestions: [
        {
          id: 'suggestion-1',
          title: 'Fix tests',
          brief: 'Repair the flaky test.',
          category: 'bug',
          targetRepositoryFullName: 'owner/repo',
        },
      ],
    });

    expect(delivered).toBe(true);
    expect(createTaskThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        buttons: [
          [
            {
              text: '▶️ Start 1',
              callbackData: 'idea:suggestion-1',
            },
          ],
        ],
      }),
    );
    expect(insertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        surface: 'discord',
        channelId: 'forum-post-1',
        threadTs: 'forum-post-1',
        workItemId: 'suggestion-1',
      }),
    ]);
  });

  it('posts current-thread suggestions without creating another thread', async () => {
    postMessageMock
      .mockResolvedValueOnce({
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
        messageId: 'message-a',
      })
      .mockResolvedValueOnce({
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
        messageId: 'message-b',
      });
    const delivered = await postCurrentThreadSuggestionsToDiscord({
      sourceTaskId: 'task-1',
      suggestionGroupKey: 'reply-1',
      createdByUserId: 'user-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      suggestions: [
        {
          id: 'suggestion-1',
          title: 'Fix tests',
          brief: 'Repair the flaky test.',
          category: 'bug',
          targetRepositoryFullName: 'owner/repo',
        },
        {
          id: 'suggestion-2',
          title: 'Add coverage',
          brief: 'Cover the regression.',
          category: 'chore',
          targetRepositoryFullName: 'owner/repo',
        },
      ],
    });

    expect(delivered).toBe(true);
    expect(createTaskThreadMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledTimes(2);
    expect(postMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'thread-1',
      }),
    );
    expect(postMessageMock.mock.calls[0]?.[0]).not.toHaveProperty('buttons');
    expect(insertValuesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        messageTs: 'message-a',
        workItemId: 'suggestion-1',
      }),
    );
    expect(insertValuesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messageTs: 'message-b',
        workItemId: 'suggestion-2',
      }),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  enqueueFollowupMock,
  envMock,
  findTelegramPrimaryChatIdMock,
  insertMock,
  insertOnConflictDoNothingMock,
  insertValuesMock,
  postTelegramMessageBestEffortMock,
  selectLimitMock,
} = vi.hoisted(() => ({
  enqueueFollowupMock: vi.fn(),
  envMock: {
    TELEGRAM_BOT_TOKEN: 'bot-token' as string | undefined,
  },
  findTelegramPrimaryChatIdMock: vi.fn(),
  insertMock: vi.fn(),
  insertOnConflictDoNothingMock: vi.fn(),
  insertValuesMock: vi.fn(),
  postTelegramMessageBestEffortMock: vi.fn(),
  selectLimitMock: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueueTelegramSuggestedTasksOnboardingFollowup: enqueueFollowupMock,
}));

vi.mock('@roomote/env', () => ({ Env: envMock }));

vi.mock('@roomote/db/server', () => ({
  agentSuggestionMessages: {
    id: 'id',
    agentType: 'agentType',
    channelId: 'channelId',
    messageTs: 'messageTs',
    suggestionKey: 'suggestionKey',
    launchClaimedAt: 'launchClaimedAt',
  },
  taskSuggestions: {
    id: 'suggestionId',
    title: 'title',
    brief: 'brief',
    investigationContext: 'investigationContext',
    targetRepositoryFullName: 'targetRepositoryFullName',
  },
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  like: vi.fn((column: unknown, pattern: unknown) => ({
    like: [column, pattern],
  })),
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: envMock.TELEGRAM_BOT_TOKEN ?? null,
    webhookSecret: null,
    botUsername: null,
  })),
  db: {
    insert: insertMock,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimitMock })),
      })),
    })),
    update: vi.fn(),
  },
}));

vi.mock('../primary-chat.js', () => ({
  findTelegramPrimaryChatId: findTelegramPrimaryChatIdMock,
}));

vi.mock('../replies.js', () => ({
  postTelegramMessageBestEffort: postTelegramMessageBestEffortMock,
}));

import { postSetupTaskSuggestionsToTelegram } from '../setup-suggestions';

describe('postSetupTaskSuggestionsToTelegram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.TELEGRAM_BOT_TOKEN = 'bot-token';
    findTelegramPrimaryChatIdMock.mockResolvedValue('8846357662');
    selectLimitMock.mockResolvedValue([]);
    insertMock.mockReturnValue({ values: insertValuesMock });
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
    });
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
    postTelegramMessageBestEffortMock.mockResolvedValue({ messageId: '900' });
    enqueueFollowupMock.mockResolvedValue({ enqueued: true, jobId: 'job-1' });
  });

  it('posts one message with a start button per idea', async () => {
    await postSetupTaskSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestions: [
        { id: 'aaa', title: 'First idea', brief: 'Do the first thing' },
        { id: 'bbb', title: 'Second idea', brief: 'Do the second thing' },
      ],
    });

    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledTimes(1);
    const posted = postTelegramMessageBestEffortMock.mock.calls[0]![0] as {
      text: string;
      buttons: Array<Array<{ text: string; callbackData?: string }>>;
    };

    expect(posted.text).toContain('First idea');
    expect(posted.text).toContain('Second idea');
    expect(posted.buttons).toEqual([
      [{ text: '▶️ Start idea 1', callbackData: 'idea:aaa' }],
      [{ text: '▶️ Start idea 2', callbackData: 'idea:bbb' }],
    ]);
  });

  it('tracks every suggestion with a unique (channelId, messageTs) pair', async () => {
    await postSetupTaskSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestions: [
        { id: 'aaa', title: 'First idea', brief: 'Do the first thing' },
        { id: 'bbb', title: 'Second idea', brief: 'Do the second thing' },
        { id: 'ccc', title: 'Third idea', brief: 'Do the third thing' },
      ],
    });

    const rows = insertValuesMock.mock.calls[0]![0] as Array<{
      channelId: string;
      messageTs: string;
      suggestionKey: string;
    }>;

    expect(rows).toHaveLength(3);
    // (channelId, messageTs) is a unique index; identical values would make
    // onConflictDoNothing silently drop all rows after the first.
    const pairKeys = new Set(
      rows.map((row) => `${row.channelId}:${row.messageTs}`),
    );
    expect(pairKeys.size).toBe(3);
    expect(rows.map((row) => row.suggestionKey)).toEqual([
      'task-1:aaa',
      'task-1:bbb',
      'task-1:ccc',
    ]);
  });

  it('schedules the 24h suggested-tasks follow-up after posting', async () => {
    await postSetupTaskSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestions: [{ id: 'aaa', title: 'First idea', brief: 'Brief' }],
    });

    expect(enqueueFollowupMock).toHaveBeenCalledWith({
      chatId: '8846357662',
      introMessageId: '900',
      sourceTaskId: 'task-1',
    });
  });

  it('skips posting when no primary chat is captured', async () => {
    findTelegramPrimaryChatIdMock.mockResolvedValue(null);

    await postSetupTaskSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestions: [{ id: 'aaa', title: 'First idea', brief: 'Brief' }],
    });

    expect(postTelegramMessageBestEffortMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});

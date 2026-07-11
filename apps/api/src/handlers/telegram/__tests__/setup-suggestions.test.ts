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
    R_TELEGRAM_BOT_TOKEN: 'bot-token' as string | undefined,
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
  trackedMessages: {
    id: 'id',
    kind: 'kind',
    dedupeKey: 'dedupeKey',
    channelId: 'channelId',
    messageTs: 'messageTs',
    workItemId: 'workItemId',
    metadata: 'metadata',
  },
  workItems: {
    id: 'id',
    status: 'status',
    title: 'title',
    brief: 'brief',
    investigationContext: 'investigationContext',
    targetRepositoryFullName: 'targetRepositoryFullName',
    launchClaimedAt: 'launchClaimedAt',
  },
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  lt: vi.fn((column: unknown, value: unknown) => ({ lt: [column, value] })),
  or: vi.fn((...conditions: unknown[]) => ({ or: conditions })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: [Array.from(strings), values],
  })),
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: envMock.R_TELEGRAM_BOT_TOKEN ?? null,
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
    query: { trackedMessages: { findFirst: vi.fn() } },
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
    envMock.R_TELEGRAM_BOT_TOKEN = 'bot-token';
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
      surface: string;
      kind: string;
      dedupeKey: string;
      channelId: string;
      messageTs: string;
      workItemId: string;
      metadata: { suggestionType: string; suggestionKey: string };
    }>;

    expect(rows).toHaveLength(3);
    // (kind, dedupeKey) is a unique index; identical values would make
    // onConflictDoNothing silently drop all rows after the first.
    const dedupeKeys = new Set(rows.map((row) => row.dedupeKey));
    expect(dedupeKeys.size).toBe(3);
    expect(rows.every((row) => row.kind === 'suggestion_card')).toBe(true);
    expect(rows.every((row) => row.surface === 'telegram')).toBe(true);
    // The backing work item id is the suggestion id (not the shared messageTs).
    expect(rows.map((row) => row.workItemId)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(rows.map((row) => row.metadata.suggestionKey)).toEqual([
      'task-1:aaa',
      'task-1:bbb',
      'task-1:ccc',
    ]);
    expect(
      rows.every((row) => row.metadata.suggestionType === 'setup_onboarding'),
    ).toBe(true);
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

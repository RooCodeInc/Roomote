import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  envMock,
  findTelegramPrimaryChatIdMock,
  getAutomationRuntimeMock,
  getAutomationTelegramTopicThreadIdMock,
  persistAutomationTelegramTopicThreadMock,
  createTelegramForumTopicBestEffortMock,
  postTelegramMessageBestEffortMock,
  insertMock,
  insertOnConflictDoNothingMock,
  insertValuesMock,
  selectLimitMock,
  buildRootMessageMock,
} = vi.hoisted(() => ({
  envMock: {
    R_TELEGRAM_BOT_TOKEN: 'bot-token' as string | undefined,
  },
  findTelegramPrimaryChatIdMock: vi.fn(),
  getAutomationRuntimeMock: vi.fn(),
  getAutomationTelegramTopicThreadIdMock: vi.fn(),
  persistAutomationTelegramTopicThreadMock: vi.fn(),
  createTelegramForumTopicBestEffortMock: vi.fn(),
  postTelegramMessageBestEffortMock: vi.fn(),
  insertMock: vi.fn(),
  insertOnConflictDoNothingMock: vi.fn(),
  insertValuesMock: vi.fn(),
  selectLimitMock: vi.fn(),
  buildRootMessageMock: vi.fn(),
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
  slackInstallations: { id: 'id', isActive: 'isActive' },
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: [Array.from(strings), values],
  })),
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: envMock.R_TELEGRAM_BOT_TOKEN ?? null,
    webhookSecret: null,
    botUsername: null,
  })),
  getAutomationRuntime: getAutomationRuntimeMock,
  getAutomationTelegramTopicThreadId: getAutomationTelegramTopicThreadIdMock,
  persistAutomationTelegramTopicThread:
    persistAutomationTelegramTopicThreadMock,
  db: {
    insert: insertMock,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimitMock })),
      })),
    })),
  },
}));

vi.mock('../primary-chat.js', () => ({
  findTelegramPrimaryChatId: findTelegramPrimaryChatIdMock,
}));

vi.mock('../replies.js', () => ({
  createTelegramForumTopicBestEffort: createTelegramForumTopicBestEffortMock,
  postTelegramMessageBestEffort: postTelegramMessageBestEffortMock,
}));

vi.mock('../../tasks/scheduled-suggestion-root-summary.js', () => ({
  buildScheduledSuggestionRootMessage: buildRootMessageMock,
}));

import {
  postCurrentThreadSuggestionsToTelegram,
  postScheduledSuggestionsToTelegram,
  SUGGEST_IDEAS_TELEGRAM_TOPIC_NAME,
} from '../automation-suggestions';

function buildSuggestion(id: string, title: string) {
  return {
    id,
    title,
    brief: `${title} brief`,
    category: null,
    targetRepositoryFullName: null,
  };
}

describe('postScheduledSuggestionsToTelegram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.R_TELEGRAM_BOT_TOKEN = 'bot-token';
    findTelegramPrimaryChatIdMock.mockResolvedValue('8846357662');
    getAutomationRuntimeMock.mockResolvedValue({
      destination: null,
      targets: [],
    });
    getAutomationTelegramTopicThreadIdMock.mockReturnValue(null);
    persistAutomationTelegramTopicThreadMock.mockResolvedValue(undefined);
    createTelegramForumTopicBestEffortMock.mockResolvedValue({
      threadId: '88',
    });
    postTelegramMessageBestEffortMock.mockResolvedValue({
      messageId: '950',
    });
    insertMock.mockReturnValue({ values: insertValuesMock });
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
    });
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
    buildRootMessageMock.mockResolvedValue({
      summaryText: 'I triaged the latest Sentry issues.',
      actionFooterText: 'footer',
    });
    selectLimitMock.mockResolvedValue([]);
  });

  it('posts current-thread suggestions without creating a topic', async () => {
    const delivered = await postCurrentThreadSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      chatId: '8846357662',
      threadId: '88',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(delivered).toBe(true);
    expect(createTelegramForumTopicBestEffortMock).not.toHaveBeenCalled();
    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '8846357662',
        threadId: '88',
        buttons: [[expect.objectContaining({ callbackData: 'idea:aaa' })]],
      }),
    );
  });

  it('posts one summary message with start buttons per suggestion', async () => {
    await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'sentry_triage',
      suggestions: [
        buildSuggestion('aaa', 'Fix crash'),
        buildSuggestion('bbb', 'Silence noise'),
      ],
    });

    expect(createTelegramForumTopicBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Suggested tasks' }),
    );
    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledTimes(1);
    const posted = postTelegramMessageBestEffortMock.mock.calls[0]![0] as {
      text: string;
      buttons: Array<Array<{ callbackData?: string }>>;
      threadId?: string;
    };

    expect(posted.text).toContain('I triaged the latest Sentry issues.');
    expect(posted.text).toContain('Fix crash');
    expect(posted.threadId).toBe('88');
    expect(posted.buttons).toEqual([
      [expect.objectContaining({ callbackData: 'idea:aaa' })],
      [expect.objectContaining({ callbackData: 'idea:bbb' })],
    ]);
  });

  it('reuses a sticky Suggest Ideas topic on later runs', async () => {
    getAutomationTelegramTopicThreadIdMock.mockReturnValue('topic-7');

    await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-2',
      createdByUserId: 'user-1',
      suggestionSource: 'suggest_ideas',
      suggestions: [buildSuggestion('aaa', 'Ship idea')],
    });

    expect(createTelegramForumTopicBestEffortMock).not.toHaveBeenCalled();
    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'topic-7',
        text: expect.stringContaining('Ship idea'),
      }),
    );
    expect(persistAutomationTelegramTopicThreadMock).not.toHaveBeenCalled();
  });

  it('creates and persists a sticky Suggest Ideas topic when none exists', async () => {
    await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-3',
      createdByUserId: null,
      suggestionSource: 'suggest_ideas',
      suggestions: [buildSuggestion('aaa', 'First idea')],
    });

    expect(createTelegramForumTopicBestEffortMock).toHaveBeenCalledWith({
      chatId: '8846357662',
      name: SUGGEST_IDEAS_TELEGRAM_TOPIC_NAME,
    });
    expect(persistAutomationTelegramTopicThreadMock).toHaveBeenCalledWith({
      automationKey: 'suggester',
      chatId: '8846357662',
      threadId: '88',
      topicName: SUGGEST_IDEAS_TELEGRAM_TOPIC_NAME,
    });
  });

  it('skips when tracked messages already exist for the source task', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'install-1' }]);

    const delivered = await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'sentry_triage',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(postTelegramMessageBestEffortMock).not.toHaveBeenCalled();
    expect(delivered).toBe(true);
  });

  it('recreates and persists a sticky topic when an existing topic post fails', async () => {
    getAutomationTelegramTopicThreadIdMock.mockReturnValue('stale-topic');
    postTelegramMessageBestEffortMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ messageId: '999' });
    createTelegramForumTopicBestEffortMock.mockResolvedValue({
      threadId: 'fresh-topic',
    });

    const delivered = await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-repair',
      createdByUserId: null,
      suggestionSource: 'suggest_ideas',
      suggestions: [buildSuggestion('aaa', 'Repair idea')],
    });

    expect(delivered).toBe(true);
    expect(createTelegramForumTopicBestEffortMock).toHaveBeenCalledWith({
      chatId: '8846357662',
      name: SUGGEST_IDEAS_TELEGRAM_TOPIC_NAME,
    });
    expect(persistAutomationTelegramTopicThreadMock).toHaveBeenCalledWith({
      automationKey: 'suggester',
      chatId: '8846357662',
      threadId: 'fresh-topic',
      topicName: SUGGEST_IDEAS_TELEGRAM_TOPIC_NAME,
    });
    expect(postTelegramMessageBestEffortMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ threadId: 'stale-topic' }),
    );
    expect(postTelegramMessageBestEffortMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threadId: 'fresh-topic' }),
    );
  });

  it('falls back to the parent chat when topic creation is unavailable', async () => {
    createTelegramForumTopicBestEffortMock.mockResolvedValue(null);
    postTelegramMessageBestEffortMock.mockResolvedValue({ messageId: '111' });

    const delivered = await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-fallback',
      createdByUserId: null,
      suggestionSource: 'suggest_ideas',
      suggestions: [buildSuggestion('aaa', 'Chat idea')],
    });

    expect(delivered).toBe(true);
    expect(persistAutomationTelegramTopicThreadMock).not.toHaveBeenCalled();
    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '8846357662',
        text: expect.stringContaining('Chat idea'),
      }),
    );
    expect(
      (
        postTelegramMessageBestEffortMock.mock.calls[0]![0] as {
          threadId?: string;
        }
      ).threadId,
    ).toBeUndefined();
  });

  it('caps buttons at five and notes the overflow', async () => {
    await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'suggest_ideas',
      suggestions: Array.from({ length: 7 }, (_, index) =>
        buildSuggestion(`id-${index}`, `Idea ${index}`),
      ),
    });

    const posted = postTelegramMessageBestEffortMock.mock.calls[0]![0] as {
      text: string;
      buttons: unknown[];
    };

    expect(posted.buttons).toHaveLength(5);
    expect(posted.text).toContain('and 2 more');
  });
});

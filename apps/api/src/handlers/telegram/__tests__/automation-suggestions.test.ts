import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  envMock,
  findTelegramPrimaryChatIdMock,
  insertMock,
  insertOnConflictDoNothingMock,
  insertValuesMock,
  postTelegramMessageBestEffortMock,
  selectLimitMock,
  buildRootMessageMock,
} = vi.hoisted(() => ({
  envMock: {
    TELEGRAM_BOT_TOKEN: 'bot-token' as string | undefined,
  },
  findTelegramPrimaryChatIdMock: vi.fn(),
  insertMock: vi.fn(),
  insertOnConflictDoNothingMock: vi.fn(),
  insertValuesMock: vi.fn(),
  postTelegramMessageBestEffortMock: vi.fn(),
  selectLimitMock: vi.fn(),
  buildRootMessageMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: envMock }));

vi.mock('@roomote/db/server', () => ({
  agentSuggestionMessages: {
    id: 'id',
    agentType: 'agentType',
    channelId: 'channelId',
    messageTs: 'messageTs',
    suggestionKey: 'suggestionKey',
  },
  slackInstallations: { id: 'id', isActive: 'isActive' },
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
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
  },
}));

vi.mock('../primary-chat.js', () => ({
  findTelegramPrimaryChatId: findTelegramPrimaryChatIdMock,
}));

vi.mock('../replies.js', () => ({
  postTelegramMessageBestEffort: postTelegramMessageBestEffortMock,
}));

vi.mock('../../tasks/scheduled-suggestion-root-summary.js', () => ({
  buildScheduledSuggestionRootMessage: buildRootMessageMock,
}));

import { postScheduledSuggestionsToTelegram } from '../automation-suggestions';

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
    envMock.TELEGRAM_BOT_TOKEN = 'bot-token';
    findTelegramPrimaryChatIdMock.mockResolvedValue('8846357662');
    insertMock.mockReturnValue({ values: insertValuesMock });
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
    });
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
    postTelegramMessageBestEffortMock.mockResolvedValue({ messageId: '950' });
    buildRootMessageMock.mockResolvedValue({
      summaryText: 'I triaged the latest Sentry issues.',
      actionFooterText: 'footer',
    });
    // First select: active Slack installation lookup (none). Second: dedup.
    selectLimitMock.mockResolvedValue([]);
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

    expect(postTelegramMessageBestEffortMock).toHaveBeenCalledTimes(1);
    const posted = postTelegramMessageBestEffortMock.mock.calls[0]![0] as {
      text: string;
      buttons: Array<Array<{ callbackData?: string }>>;
    };

    expect(posted.text).toContain('I triaged the latest Sentry issues.');
    expect(posted.text).toContain('Fix crash');
    expect(posted.buttons).toEqual([
      [expect.objectContaining({ callbackData: 'idea:aaa' })],
      [expect.objectContaining({ callbackData: 'idea:bbb' })],
    ]);

    const rows = insertValuesMock.mock.calls[0]![0] as Array<{
      agentType: string;
      messageTs: string;
    }>;
    expect(rows.map((row) => row.agentType)).toEqual([
      'sentry_triage',
      'sentry_triage',
    ]);
    expect(new Set(rows.map((row) => row.messageTs)).size).toBe(2);
  });

  it('skips when an active Slack installation exists', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'install-1' }]);

    await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'sentry_triage',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(postTelegramMessageBestEffortMock).not.toHaveBeenCalled();
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

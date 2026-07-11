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
    R_TELEGRAM_BOT_TOKEN: 'bot-token' as string | undefined,
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
    envMock.R_TELEGRAM_BOT_TOKEN = 'bot-token';
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
    // The only `.limit()` lookup is now the dedup query (Slack self-suppression
    // was removed; surface precedence is owned by the caller).
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
      kind: string;
      surface: string;
      dedupeKey: string;
      messageTs: string;
      workItemId: string;
      metadata: { suggestionType: string; suggestionKey: string };
    }>;
    expect(rows.map((row) => row.metadata.suggestionType)).toEqual([
      'sentry_triage',
      'sentry_triage',
    ]);
    expect(rows.every((row) => row.kind === 'suggestion_card')).toBe(true);
    expect(rows.every((row) => row.surface === 'telegram')).toBe(true);
    expect(rows.map((row) => row.workItemId)).toEqual(['aaa', 'bbb']);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
  });

  it('skips when tracked messages already exist for the source task', async () => {
    // The dedup lookup finds a tracked row (Slack self-suppression removed).
    selectLimitMock.mockResolvedValueOnce([{ id: 'install-1' }]);

    const delivered = await postScheduledSuggestionsToTelegram({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'sentry_triage',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(postTelegramMessageBestEffortMock).not.toHaveBeenCalled();
    // Already delivered on a prior run -> reported as delivered so Teams stays
    // suppressed.
    expect(delivered).toBe(true);
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

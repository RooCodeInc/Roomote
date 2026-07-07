import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildRootMessageMock,
  findPrimaryConversationMock,
  findTelegramPrimaryChatIdMock,
  insertMock,
  insertOnConflictDoNothingMock,
  insertValuesMock,
  postMessageMock,
  selectLimitMock,
  selectWhereRowsMock,
  telegramCredentialsMock,
} = vi.hoisted(() => ({
  buildRootMessageMock: vi.fn(),
  findPrimaryConversationMock: vi.fn(),
  findTelegramPrimaryChatIdMock: vi.fn(),
  insertMock: vi.fn(),
  insertOnConflictDoNothingMock: vi.fn(),
  insertValuesMock: vi.fn(),
  postMessageMock: vi.fn(),
  selectLimitMock: vi.fn(),
  selectWhereRowsMock: vi.fn(),
  telegramCredentialsMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { ROOMOTE_APP_URL: 'https://app.example.com' },
}));

vi.mock('@roomote/db/server', () => ({
  agentSuggestionMessages: {
    id: 'id',
    agentType: 'agentType',
    channelId: 'channelId',
    messageTs: 'messageTs',
    suggestionKey: 'suggestionKey',
  },
  environments: { id: 'id', name: 'name' },
  slackInstallations: { id: 'id', isActive: 'isActive' },
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  inArray: vi.fn((column: unknown, values: unknown) => ({
    inArray: [column, values],
  })),
  like: vi.fn((column: unknown, pattern: unknown) => ({
    like: [column, pattern],
  })),
  resolveTelegramRuntimeCredentials: telegramCredentialsMock,
  db: {
    insert: insertMock,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // `.where(...).limit()` is used by the Slack-installation and dedup
        // lookups; `.where(...)` awaited directly is used by the environment-
        // name lookup, so the returned object is both a thenable resolving to
        // `selectWhereRowsMock()` and carries a `.limit` override.
        where: vi.fn(() => {
          const chain = {
            limit: selectLimitMock,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve(selectWhereRowsMock()).then(resolve),
          };
          return chain;
        }),
      })),
    })),
  },
}));

vi.mock('../automation-messaging.js', () => ({
  findTeamsPrimaryConversation: findPrimaryConversationMock,
  postTeamsAutomationMessageBestEffort: postMessageMock,
}));

vi.mock('../../telegram/primary-chat.js', () => ({
  findTelegramPrimaryChatId: findTelegramPrimaryChatIdMock,
}));

vi.mock('../../tasks/scheduled-suggestion-root-summary.js', () => ({
  buildScheduledSuggestionRootMessage: buildRootMessageMock,
}));

import { postScheduledSuggestionsToTeams } from '../automation-suggestions';

function buildSuggestion(id: string, title: string) {
  return {
    id,
    title,
    brief: `${title} brief`,
    category: null,
    targetRepositoryFullName: null,
    targetEnvironmentId: null,
  };
}

describe('postScheduledSuggestionsToTeams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // First select: active Slack installation lookup (none). Second: dedup.
    selectLimitMock.mockResolvedValue([]);
    telegramCredentialsMock.mockResolvedValue({
      botToken: null,
      webhookSecret: null,
      botUsername: null,
    });
    findTelegramPrimaryChatIdMock.mockResolvedValue(null);
    findPrimaryConversationMock.mockResolvedValue({
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    });
    insertMock.mockReturnValue({ values: insertValuesMock });
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
    });
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
    postMessageMock.mockResolvedValue({ messageId: '1720000000000' });
    selectWhereRowsMock.mockReturnValue([]);
    buildRootMessageMock.mockResolvedValue({
      summaryText: 'I triaged the latest Sentry issues.',
      actionFooterText: 'footer',
    });
  });

  it('posts one summary message with an automations link', async () => {
    await postScheduledSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'sentry_triage',
      suggestions: [
        buildSuggestion('aaa', 'Fix crash'),
        buildSuggestion('bbb', 'Silence noise'),
      ],
    });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const posted = postMessageMock.mock.calls[0]![0] as {
      conversationId: string;
      serviceUrl: string;
      text: string;
    };

    expect(posted.conversationId).toBe('19:channel@thread.tacv2');
    expect(posted.text).toContain('I triaged the latest Sentry issues.');
    expect(posted.text).toContain('Fix crash');
    expect(posted.text).toContain('https://app.example.com/automations');
    // Each idea carries an italic "Automation in Environment" bottom line.
    expect(posted.text).toContain('_Triage Sentry Issues_');

    const rows = insertValuesMock.mock.calls[0]![0] as Array<{
      channelId: string;
      messageTs: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.messageTs)).size).toBe(2);
    expect(rows[0]!.channelId).toBe('19:channel@thread.tacv2');
  });

  it('skips when an active Slack installation exists', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'install-1' }]);

    await postScheduledSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'sentry_triage',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips when a Telegram automation destination exists', async () => {
    telegramCredentialsMock.mockResolvedValueOnce({
      botToken: 'bot-token',
      webhookSecret: null,
      botUsername: null,
    });
    findTelegramPrimaryChatIdMock.mockResolvedValueOnce('8846357662');

    await postScheduledSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'sentry_triage',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips when tracked messages already exist for the source task', async () => {
    // Slack gate (empty), then the dedup lookup finds a tracked row.
    selectLimitMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'existing' }]);

    await postScheduledSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'sentry_triage',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('caps the list at five and notes the overflow', async () => {
    await postScheduledSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'suggest_ideas',
      suggestions: Array.from({ length: 7 }, (_, index) =>
        buildSuggestion(`id-${index}`, `Idea ${index}`),
      ),
    });

    const posted = postMessageMock.mock.calls[0]![0] as { text: string };

    expect(posted.text).toContain('and 2 more');
    const rows = insertValuesMock.mock.calls[0]![0] as unknown[];
    expect(rows).toHaveLength(5);
  });

  it('renders "Automation in Environment" when a suggestion has a target environment', async () => {
    selectWhereRowsMock.mockReturnValue([{ id: 'env-1', name: 'OpenRoomote' }]);

    await postScheduledSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestionSource: 'suggest_ideas',
      suggestions: [
        {
          id: 'aaa',
          title: 'Fix cron retries',
          brief: 'Fix cron retries',
          category: 'bug',
          targetRepositoryFullName: 'acme/app',
          targetEnvironmentId: 'env-1',
        },
      ],
    });

    const posted = postMessageMock.mock.calls[0]![0] as { text: string };
    expect(posted.text).toContain('_Suggest Ideas in OpenRoomote_');
  });
});

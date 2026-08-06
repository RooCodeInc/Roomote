import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildRootMessageMock,
  findPrimaryConversationMock,
  getAutomationRuntimeMock,
  insertMock,
  insertOnConflictDoNothingMock,
  insertValuesMock,
  postMessageMock,
  selectLimitMock,
  selectWhereRowsMock,
} = vi.hoisted(() => ({
  buildRootMessageMock: vi.fn(),
  findPrimaryConversationMock: vi.fn(),
  getAutomationRuntimeMock: vi.fn(),
  insertMock: vi.fn(),
  insertOnConflictDoNothingMock: vi.fn(),
  insertValuesMock: vi.fn(),
  postMessageMock: vi.fn(),
  selectLimitMock: vi.fn(),
  selectWhereRowsMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://app.example.com' },
}));

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
  environments: { id: 'id', name: 'name' },
  teamsInstallations: {
    conversationId: 'conversationId',
    serviceUrl: 'serviceUrl',
    isActive: 'isActive',
  },
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  inArray: vi.fn((column: unknown, values: unknown) => ({
    inArray: [column, values],
  })),
  isNotNull: vi.fn((column: unknown) => ({ isNotNull: column })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: [Array.from(strings), values],
  })),
  getAutomationRuntime: getAutomationRuntimeMock,
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

vi.mock('../../tasks/scheduled-suggestion-root-summary.js', () => ({
  buildScheduledSuggestionRootMessage: buildRootMessageMock,
}));

import {
  postCurrentThreadSuggestionsToTeams,
  postScheduledSuggestionsToTeams,
} from '../automation-suggestions';

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
    // The primary-conversation path only performs the dedup lookup. A
    // configured Teams target adds one installation lookup before it.
    selectLimitMock.mockResolvedValue([]);
    getAutomationRuntimeMock.mockResolvedValue({ destination: null });
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

  it('posts current-thread suggestions to the bound conversation', async () => {
    const delivered = await postCurrentThreadSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      conversationId: '19:bound@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      threadId: 'activity-root',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(delivered).toBe(true);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:bound@thread.tacv2',
        threadId: 'activity-root',
        text: expect.stringContaining('Fix crash'),
      }),
    );
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
      kind: string;
      surface: string;
      channelId: string;
      dedupeKey: string;
      messageTs: string;
      workItemId: string;
      metadata: { suggestionType: string; suggestionKey: string };
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'suggestion_card')).toBe(true);
    expect(rows.every((row) => row.surface === 'teams')).toBe(true);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
    expect(rows.map((row) => row.workItemId)).toEqual(['aaa', 'bbb']);
    expect(rows[0]!.channelId).toBe('19:channel@thread.tacv2');
  });

  it('uses the configured Teams destination instead of the primary conversation', async () => {
    getAutomationRuntimeMock.mockResolvedValue({
      destination: {
        provider: 'teams',
        channelId: '19:configured@thread.tacv2',
        source: 'automation_target',
      },
    });
    selectLimitMock
      .mockResolvedValueOnce([
        {
          conversationId: '19:configured@thread.tacv2',
          serviceUrl: 'https://smba.trafficmanager.net/configured/',
        },
      ])
      .mockResolvedValueOnce([]);

    await postScheduledSuggestionsToTeams({
      sourceTaskId: 'task-configured',
      createdByUserId: 'user-1',
      suggestionSource: 'suggest_ideas',
      suggestions: [buildSuggestion('aaa', 'Fix crash')],
    });

    expect(findPrimaryConversationMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:configured@thread.tacv2',
        serviceUrl: 'https://smba.trafficmanager.net/configured/',
      }),
    );
  });

  it('skips when tracked messages already exist for the source task', async () => {
    // The dedup lookup finds a tracked row (surface self-suppression removed).
    selectLimitMock.mockResolvedValueOnce([{ id: 'existing' }]);

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
    selectWhereRowsMock.mockReturnValue([{ id: 'env-1', name: 'Roomote' }]);

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
    expect(posted.text).toContain('_Suggest Ideas in Roomote_');
  });
});

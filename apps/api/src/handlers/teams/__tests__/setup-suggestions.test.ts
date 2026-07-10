import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  enqueueFollowupMock,
  findPrimaryConversationMock,
  findTelegramPrimaryChatIdMock,
  insertMock,
  insertOnConflictDoNothingMock,
  insertValuesMock,
  postMessageMock,
  selectLimitMock,
  telegramCredentialsMock,
} = vi.hoisted(() => ({
  enqueueFollowupMock: vi.fn(),
  findPrimaryConversationMock: vi.fn(),
  findTelegramPrimaryChatIdMock: vi.fn(),
  insertMock: vi.fn(),
  insertOnConflictDoNothingMock: vi.fn(),
  insertValuesMock: vi.fn(),
  postMessageMock: vi.fn(),
  selectLimitMock: vi.fn(),
  telegramCredentialsMock: vi.fn(),
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
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: [Array.from(strings), values],
  })),
  resolveTelegramRuntimeCredentials: telegramCredentialsMock,
  db: {
    insert: insertMock,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimitMock })),
      })),
    })),
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueueTeamsSuggestedTasksOnboardingFollowup: enqueueFollowupMock,
}));

vi.mock('../automation-messaging.js', () => ({
  findTeamsPrimaryConversation: findPrimaryConversationMock,
  postTeamsAutomationMessageBestEffort: postMessageMock,
}));

vi.mock('../../telegram/primary-chat.js', () => ({
  findTelegramPrimaryChatId: findTelegramPrimaryChatIdMock,
}));

import { postSetupTaskSuggestionsToTeams } from '../setup-suggestions';

const SUGGESTIONS = [
  { id: 'aaa', title: 'Fix crash', brief: 'Fix the crash brief' },
  { id: 'bbb', title: 'Silence noise', brief: 'Silence noise brief' },
];

describe('postSetupTaskSuggestionsToTeams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    postMessageMock.mockResolvedValue({ messageId: '900' });
    enqueueFollowupMock.mockResolvedValue({ enqueued: true, jobId: 'job-1' });
  });

  it('posts one intro message and schedules the follow-up', async () => {
    await postSetupTaskSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestions: SUGGESTIONS,
    });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const posted = postMessageMock.mock.calls[0]![0] as { text: string };
    expect(posted.text).toContain('Fix crash');
    expect(posted.text).toContain('starter tasks');

    const rows = insertValuesMock.mock.calls[0]![0] as Array<{
      kind: string;
      surface: string;
      dedupeKey: string;
      messageTs: string;
      workItemId: string;
      metadata: { suggestionType: string; suggestionKey: string };
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('suggestion_card');
    expect(rows[0]!.surface).toBe('teams');
    expect(rows[0]!.metadata.suggestionType).toBe('setup_onboarding');
    expect(rows.map((row) => row.workItemId)).toEqual(['aaa', 'bbb']);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);

    expect(enqueueFollowupMock).toHaveBeenCalledWith({
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      introMessageId: '900',
      sourceTaskId: 'task-1',
    });
  });

  it('skips when a Telegram onboarding destination exists', async () => {
    telegramCredentialsMock.mockResolvedValueOnce({
      botToken: 'bot-token',
      webhookSecret: null,
      botUsername: null,
    });
    findTelegramPrimaryChatIdMock.mockResolvedValueOnce('8846357662');

    await postSetupTaskSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestions: SUGGESTIONS,
    });

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips when tracked messages already exist for the source task', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'existing' }]);

    await postSetupTaskSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestions: SUGGESTIONS,
    });

    expect(postMessageMock).not.toHaveBeenCalled();
    expect(enqueueFollowupMock).not.toHaveBeenCalled();
  });

  it('skips without a primary Teams conversation', async () => {
    findPrimaryConversationMock.mockResolvedValueOnce(null);

    await postSetupTaskSuggestionsToTeams({
      sourceTaskId: 'task-1',
      createdByUserId: 'user-1',
      suggestions: SUGGESTIONS,
    });

    expect(postMessageMock).not.toHaveBeenCalled();
  });
});

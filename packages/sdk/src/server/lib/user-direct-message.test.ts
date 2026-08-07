import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockOpenConversation,
  mockPostDirectMessage,
  mockSlackInstallationsFindMany,
  mockSlackPostMessage,
  mockSlackUserMappingsFindFirst,
  mockTeamsUserMappingsFindFirst,
  mockTelegramPostMessage,
  mockTelegramUserMappingsFindFirst,
} = vi.hoisted(() => ({
  mockOpenConversation: vi.fn(),
  mockPostDirectMessage: vi.fn(),
  mockSlackInstallationsFindMany: vi.fn(),
  mockSlackPostMessage: vi.fn(),
  mockSlackUserMappingsFindFirst: vi.fn(),
  mockTeamsUserMappingsFindFirst: vi.fn(),
  mockTelegramPostMessage: vi.fn(),
  mockTelegramUserMappingsFindFirst: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: { findMany: mockSlackInstallationsFindMany },
      slackUserMappings: { findFirst: mockSlackUserMappingsFindFirst },
      teamsUserMappings: { findFirst: mockTeamsUserMappingsFindFirst },
      telegramUserMappings: { findFirst: mockTelegramUserMappingsFindFirst },
    },
  },
  and: vi.fn(),
  eq: vi.fn(),
  slackInstallations: {},
  slackUserMappings: {},
  teamsUserMappings: {},
  telegramUserMappings: {},
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn().mockImplementation(function () {
    return {
      openConversation: mockOpenConversation,
      postMessage: mockSlackPostMessage,
    };
  }),
}));

vi.mock('./teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: vi.fn(async () => ({
    postDirectMessage: mockPostDirectMessage,
  })),
}));

vi.mock('./telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials: vi.fn(
    async () => ({ postMessage: mockTelegramPostMessage }),
  ),
}));

vi.mock('./teams-primary-conversation', () => ({
  findTeamsPrimaryConversation: vi.fn(async () => ({
    conversationId: 'conversation-1',
    serviceUrl: 'https://smba.example.com/amer/',
    conversationType: 'personal',
  })),
}));

import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import {
  findSlackUserDirectMessageDestination,
  sendUserDirectMessageBestEffort,
} from './user-direct-message';

describe('findSlackUserDirectMessageDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlackInstallationsFindMany.mockResolvedValue([
      { botAccessToken: 'xoxb-token', teamId: 'T123' },
    ]);
    mockSlackUserMappingsFindFirst.mockResolvedValue({ slackUserId: 'U123' });
    mockOpenConversation.mockResolvedValue('D123');
  });

  it('opens a DM for the linked Slack identity', async () => {
    await expect(
      findSlackUserDirectMessageDestination('user-1'),
    ).resolves.toEqual({ channelId: 'D123', teamId: 'T123' });
    expect(mockOpenConversation).toHaveBeenCalledWith('U123');
  });

  it('returns null when the user has no linked Slack identity', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);

    await expect(
      findSlackUserDirectMessageDestination('user-1'),
    ).resolves.toBeNull();
    expect(mockOpenConversation).not.toHaveBeenCalled();
  });
});

describe('sendUserDirectMessageBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSlackInstallationsFindMany.mockResolvedValue([
      { botAccessToken: 'xoxb-token', teamId: 'T123' },
    ]);
    mockSlackUserMappingsFindFirst.mockResolvedValue({ slackUserId: 'U123' });
    mockOpenConversation.mockResolvedValue('D123');
    mockSlackPostMessage.mockResolvedValue('1720000000.000100');

    mockTeamsUserMappingsFindFirst.mockResolvedValue({
      teamsUserId: 'teams-user-1',
      teamsTenantId: 'tenant-1',
    });
    mockPostDirectMessage.mockResolvedValue({ messageId: 'teams-message-1' });

    mockTelegramUserMappingsFindFirst.mockResolvedValue({
      telegramChatId: '424242',
    });
    mockTelegramPostMessage.mockResolvedValue({ messageId: '77' });
  });

  it('sends the message on every provider with a linked identity', async () => {
    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'Your GitHub installation request was approved.',
      logContext: 'test',
    });

    expect(delivered).toEqual(['slack', 'teams', 'telegram']);

    expect(mockOpenConversation).toHaveBeenCalledWith('U123');
    expect(mockSlackPostMessage).toHaveBeenCalledWith({
      channel: 'D123',
      text: 'Your GitHub installation request was approved.',
    });

    expect(mockPostDirectMessage).toHaveBeenCalledWith({
      serviceUrl: 'https://smba.example.com/amer/',
      tenantId: 'tenant-1',
      userId: 'teams-user-1',
      text: 'Your GitHub installation request was approved.',
      textFormat: 'markdown',
    });

    expect(mockTelegramPostMessage).toHaveBeenCalledWith({
      channelId: '424242',
      text: 'Your GitHub installation request was approved.',
      textFormat: 'markdown',
    });
  });

  it('skips providers the user has not linked without failing the rest', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'hello',
      logContext: 'test',
    });

    expect(delivered).toEqual(['telegram']);
    expect(mockSlackPostMessage).not.toHaveBeenCalled();
    expect(mockPostDirectMessage).not.toHaveBeenCalled();
  });

  it('skips a provider whose credentials are not configured', async () => {
    vi.mocked(
      createTelegramCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValueOnce(null);

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'hello',
      logContext: 'test',
    });

    expect(delivered).toEqual(['slack', 'teams']);
    expect(mockTelegramPostMessage).not.toHaveBeenCalled();
  });

  it('swallows a provider error and still delivers the others', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSlackPostMessage.mockRejectedValue(new Error('slack is down'));

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'hello',
      logContext: 'test',
    });

    expect(delivered).toEqual(['teams', 'telegram']);
    expect(warnSpy).toHaveBeenCalledWith(
      '[test] Failed to send Slack DM: slack is down',
    );

    warnSpy.mockRestore();
  });
});

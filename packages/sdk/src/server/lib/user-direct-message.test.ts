import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockOpenConversation,
  mockCreateDiscordDirectMessage,
  mockCreateTeamsDirectMessage,
  mockDiscordPostMessage,
  mockDiscordUserMappingsFindFirst,
  mockPostDirectMessage,
  mockSlackInstallationsFindMany,
  mockSlackPostMessage,
  mockSlackUserMappingsFindFirst,
  mockTeamsUserMappingsFindFirst,
  mockTelegramPostMessage,
  mockTelegramUserMappingsFindFirst,
} = vi.hoisted(() => ({
  mockOpenConversation: vi.fn(),
  mockCreateDiscordDirectMessage: vi.fn(),
  mockCreateTeamsDirectMessage: vi.fn(),
  mockDiscordPostMessage: vi.fn(),
  mockDiscordUserMappingsFindFirst: vi.fn(),
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
      discordUserMappings: { findFirst: mockDiscordUserMappingsFindFirst },
      teamsUserMappings: { findFirst: mockTeamsUserMappingsFindFirst },
      telegramUserMappings: { findFirst: mockTelegramUserMappingsFindFirst },
    },
  },
  and: vi.fn(),
  discordUserMappings: {},
  eq: vi.fn(),
  slackInstallations: {},
  slackUserMappings: {},
  teamsUserMappings: {},
  telegramUserMappings: {},
}));

vi.mock('./discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials: vi.fn(async () => ({
    createDirectMessage: mockCreateDiscordDirectMessage,
    postMessage: mockDiscordPostMessage,
  })),
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
    createDirectMessage: mockCreateTeamsDirectMessage,
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
  findUserDirectMessageDestination,
  sendUserDirectMessage,
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

describe('findUserDirectMessageDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamsUserMappingsFindFirst.mockResolvedValue({
      teamsUserId: 'teams-user-1',
      teamsTenantId: 'tenant-1',
    });
    mockCreateTeamsDirectMessage.mockResolvedValue({ channelId: 'teams-dm-1' });
    mockTelegramUserMappingsFindFirst.mockResolvedValue({
      telegramChatId: '424242',
    });
    mockDiscordUserMappingsFindFirst.mockResolvedValue({
      discordDmChannelId: 'discord-dm-1',
      discordUserId: 'discord-user-1',
    });
  });

  it('creates a Teams conversation for the linked identity', async () => {
    await expect(
      findUserDirectMessageDestination('teams', 'user-1'),
    ).resolves.toEqual({
      channelId: 'teams-dm-1',
      serviceUrl: 'https://smba.example.com/amer/',
    });
    expect(mockCreateTeamsDirectMessage).toHaveBeenCalledWith({
      serviceUrl: 'https://smba.example.com/amer/',
      tenantId: 'tenant-1',
      userId: 'teams-user-1',
    });
  });

  it('uses the linked Telegram chat', async () => {
    await expect(
      findUserDirectMessageDestination('telegram', 'user-1'),
    ).resolves.toEqual({ channelId: '424242' });
  });

  it('reuses the linked Discord DM channel', async () => {
    await expect(
      findUserDirectMessageDestination('discord', 'user-1'),
    ).resolves.toEqual({ channelId: 'discord-dm-1' });
    expect(mockCreateDiscordDirectMessage).not.toHaveBeenCalled();
  });

  it('creates a Discord DM when the linked channel is missing', async () => {
    mockDiscordUserMappingsFindFirst.mockResolvedValue({
      discordDmChannelId: null,
      discordUserId: 'discord-user-1',
    });
    mockCreateDiscordDirectMessage.mockResolvedValue({
      id: 'discord-dm-2',
    });

    await expect(
      findUserDirectMessageDestination('discord', 'user-1'),
    ).resolves.toEqual({ channelId: 'discord-dm-2' });
    expect(mockCreateDiscordDirectMessage).toHaveBeenCalledWith(
      'discord-user-1',
    );
  });
});

describe('sendUserDirectMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscordUserMappingsFindFirst.mockResolvedValue({
      discordDmChannelId: 'discord-dm-1',
      discordUserId: 'discord-user-1',
    });
    mockDiscordPostMessage.mockResolvedValue({
      messageId: 'discord-message-1',
    });
  });

  it('sends to a linked Discord DM', async () => {
    await expect(
      sendUserDirectMessage({
        provider: 'discord',
        userId: 'user-1',
        text: 'hello',
        logContext: 'test',
      }),
    ).resolves.toBe(true);
    expect(mockDiscordPostMessage).toHaveBeenCalledWith({
      channelId: 'discord-dm-1',
      text: 'hello',
      textFormat: 'markdown',
    });
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

    mockDiscordUserMappingsFindFirst.mockResolvedValue({
      discordDmChannelId: 'discord-dm-1',
      discordUserId: 'discord-user-1',
    });
    mockDiscordPostMessage.mockResolvedValue({
      messageId: 'discord-message-1',
    });
  });

  it('sends the message on every provider with a linked identity', async () => {
    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'Your GitHub installation request was approved.',
      logContext: 'test',
    });

    expect(delivered).toEqual(['slack', 'teams', 'telegram', 'discord']);

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

    expect(mockDiscordPostMessage).toHaveBeenCalledWith({
      channelId: 'discord-dm-1',
      text: 'Your GitHub installation request was approved.',
      textFormat: 'markdown',
    });
  });

  it('sends the message when Discord is the only linked provider', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTelegramUserMappingsFindFirst.mockResolvedValue(undefined);

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'hello',
      logContext: 'test',
    });

    expect(delivered).toEqual(['discord']);
    expect(mockDiscordPostMessage).toHaveBeenCalledWith({
      channelId: 'discord-dm-1',
      text: 'hello',
      textFormat: 'markdown',
    });
  });

  it('skips providers the user has not linked without failing the rest', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);
    mockDiscordUserMappingsFindFirst.mockResolvedValue(undefined);

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

    expect(delivered).toEqual(['slack', 'teams', 'discord']);
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

    expect(delivered).toEqual(['teams', 'telegram', 'discord']);
    expect(warnSpy).toHaveBeenCalledWith(
      '[test] Failed to send Slack DM: slack is down',
    );

    warnSpy.mockRestore();
  });
});

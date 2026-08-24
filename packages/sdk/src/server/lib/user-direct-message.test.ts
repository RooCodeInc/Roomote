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
  attemptUserDirectMessage,
  findSlackUserDirectMessageDestination,
  findUserDirectMessageDestination,
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

describe('attemptUserDirectMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlackInstallationsFindMany.mockResolvedValue([
      { botAccessToken: 'xoxb-token', teamId: 'T123' },
    ]);
    mockSlackUserMappingsFindFirst.mockResolvedValue({ slackUserId: 'U123' });
    mockOpenConversation.mockResolvedValue('D123');
    mockSlackPostMessage.mockResolvedValue('1720000000.000100');
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
      attemptUserDirectMessage({
        provider: 'discord',
        userId: 'user-1',
        text: 'hello',
        logContext: 'test',
      }),
    ).resolves.toEqual({ provider: 'discord', status: 'sent' });
    expect(mockDiscordPostMessage).toHaveBeenCalledWith({
      channelId: 'discord-dm-1',
      text: 'hello',
      textFormat: 'markdown',
    });
  });

  it('returns unlinked without attempting delivery when no identity exists', async () => {
    mockTelegramUserMappingsFindFirst.mockResolvedValue(undefined);

    await expect(
      attemptUserDirectMessage({
        provider: 'telegram',
        userId: 'user-1',
        text: 'hello',
        logContext: 'test',
      }),
    ).resolves.toEqual({ provider: 'telegram', status: 'unlinked' });
    expect(mockTelegramPostMessage).not.toHaveBeenCalled();
  });

  it('returns failed when a linked provider has no credentials', async () => {
    mockTelegramUserMappingsFindFirst.mockResolvedValue({
      telegramChatId: '424242',
    });
    vi.mocked(
      createTelegramCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValueOnce(null);

    await expect(
      attemptUserDirectMessage({
        provider: 'telegram',
        userId: 'user-1',
        text: 'hello',
        logContext: 'test',
      }),
    ).resolves.toEqual({ provider: 'telegram', status: 'failed' });
    expect(mockTelegramPostMessage).not.toHaveBeenCalled();
  });

  it('resolves a linked Slack identity only once before delivery', async () => {
    await expect(
      attemptUserDirectMessage({
        provider: 'slack',
        userId: 'user-1',
        text: 'hello',
        logContext: 'test',
      }),
    ).resolves.toEqual({ provider: 'slack', status: 'sent' });
    expect(mockSlackUserMappingsFindFirst).toHaveBeenCalledTimes(1);
  });

  it('returns failed and logs when provider delivery throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSlackPostMessage.mockRejectedValue(new Error('slack is down'));

    await expect(
      attemptUserDirectMessage({
        provider: 'slack',
        userId: 'user-1',
        text: 'hello',
        logContext: 'test',
      }),
    ).resolves.toEqual({ provider: 'slack', status: 'failed' });
    expect(warnSpy).toHaveBeenCalledWith(
      '[test] Failed to send Slack DM: slack is down',
    );

    warnSpy.mockRestore();
  });
});

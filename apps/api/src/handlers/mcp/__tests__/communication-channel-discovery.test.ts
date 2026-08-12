const {
  findDiscordInstallationsMock,
  findDiscordUserMappingMock,
  findSlackInstallationsMock,
  findSlackUserMappingMock,
  findTeamsInstallationsMock,
  getCommunicationProviderAdapterMock,
  createDiscordProviderMock,
  canDiscordUserAccessChannelMock,
  listAccessibleChannelsMock,
  isSlackUserInChannelMock,
} = vi.hoisted(() => ({
  findDiscordInstallationsMock: vi.fn(),
  findDiscordUserMappingMock: vi.fn(),
  findSlackInstallationsMock: vi.fn(),
  findSlackUserMappingMock: vi.fn(),
  findTeamsInstallationsMock: vi.fn(),
  getCommunicationProviderAdapterMock: vi.fn(),
  createDiscordProviderMock: vi.fn(),
  canDiscordUserAccessChannelMock: vi.fn(),
  listAccessibleChannelsMock: vi.fn(),
  isSlackUserInChannelMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      discordInstallations: { findMany: findDiscordInstallationsMock },
      discordUserMappings: { findFirst: findDiscordUserMappingMock },
      slackInstallations: { findMany: findSlackInstallationsMock },
      slackUserMappings: { findFirst: findSlackUserMappingMock },
      teamsInstallations: { findMany: findTeamsInstallationsMock },
    },
  },
  discordInstallationChannels: { isAvailable: 'isAvailable' },
  discordUserMappings: { userId: 'userId' },
  eq: vi.fn(() => 'condition'),
  and: vi.fn(() => 'condition'),
  slackUserMappings: { userId: 'userId', slackTeamId: 'slackTeamId' },
  teamsInstallations: { isActive: 'isActive' },
}));

vi.mock('@roomote/sdk/server', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    createDiscordProviderMock,
  getCommunicationProviderAdapter: getCommunicationProviderAdapterMock,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    listAccessibleChannels = listAccessibleChannelsMock;
    isUserInChannel = isSlackUserInChannelMock;
  },
}));

import { listCommunicationChannels } from '../communication-channel-discovery';

describe('listCommunicationChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findSlackInstallationsMock.mockResolvedValue([]);
    findTeamsInstallationsMock.mockResolvedValue([]);
    findDiscordInstallationsMock.mockResolvedValue([]);
    findDiscordUserMappingMock.mockResolvedValue(null);
    findSlackUserMappingMock.mockResolvedValue(null);
    getCommunicationProviderAdapterMock.mockResolvedValue(null);
    createDiscordProviderMock.mockResolvedValue({
      canUserAccessChannel: canDiscordUserAccessChannelMock,
    });
    canDiscordUserAccessChannelMock.mockResolvedValue(true);
    listAccessibleChannelsMock.mockResolvedValue([]);
    isSlackUserInChannelMock.mockResolvedValue(true);
  });

  it('normalizes discoverable channels and excludes Slack channels the app has not joined', async () => {
    findSlackInstallationsMock.mockResolvedValue([
      { botAccessToken: 'token', teamId: 'T1', teamName: 'Acme' },
    ]);
    findSlackUserMappingMock.mockResolvedValue({ slackUserId: 'U1' });
    listAccessibleChannelsMock.mockResolvedValue([
      {
        id: 'C1',
        name: 'engineering',
        isPrivate: false,
        isMember: true,
      },
      {
        id: 'C2',
        name: 'not-joined',
        isPrivate: false,
        isMember: false,
      },
      {
        id: 'C3',
        name: 'private-engineering',
        isPrivate: true,
        isMember: true,
      },
    ]);
    findDiscordInstallationsMock.mockResolvedValue([
      {
        guildId: 'G1',
        guildName: 'Builders',
        channels: [
          {
            channelId: 'D1',
            channelName: 'general',
            channelType: 0,
            parentId: null,
          },
          {
            channelId: 'D2',
            channelName: 'voice',
            channelType: 2,
            parentId: null,
          },
        ],
      },
    ]);
    findDiscordUserMappingMock.mockResolvedValue({ discordUserId: 'DU1' });
    findTeamsInstallationsMock.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        teamId: 'team-1',
        teamName: 'Product',
        channelId: 'native-1',
        channelName: 'Launches',
        conversationId: 'conversation-1',
        conversationType: 'channel',
      },
    ]);
    await expect(
      listCommunicationChannels({ actingUserId: 'user-1' }),
    ).resolves.toEqual({
      channelCount: 3,
      platforms: [
        {
          provider: 'slack',
          platform: 'Slack',
          connected: true,
          discoverySupported: true,
          channels: [
            {
              id: 'C1',
              name: 'engineering',
              kind: 'public',
              workspaceId: 'T1',
              workspaceName: 'Acme',
            },
            {
              id: 'C3',
              name: 'private-engineering',
              kind: 'private',
              workspaceId: 'T1',
              workspaceName: 'Acme',
            },
          ],
        },
        {
          provider: 'teams',
          platform: 'Microsoft Teams',
          connected: true,
          discoverySupported: false,
          channels: [],
          limitation:
            'Microsoft Teams does not currently expose a safe deployment-wide channel list with acting-user access checks.',
        },
        {
          provider: 'telegram',
          platform: 'Telegram',
          connected: false,
          discoverySupported: false,
          channels: [],
          limitation:
            'Telegram Bot API does not provide a way to enumerate chats available to a bot.',
        },
        {
          provider: 'discord',
          platform: 'Discord',
          connected: true,
          discoverySupported: true,
          channels: [
            {
              id: 'D1',
              name: 'general',
              kind: 'text',
              workspaceId: 'G1',
              workspaceName: 'Builders',
            },
          ],
        },
      ],
    });
  });

  it('does not reveal Slack or Discord channels without linked accounts', async () => {
    findSlackInstallationsMock.mockResolvedValue([
      { botAccessToken: 'token', teamId: 'T1', teamName: 'Acme' },
    ]);
    listAccessibleChannelsMock.mockResolvedValue([
      {
        id: 'C1',
        name: 'public-room',
        isPrivate: false,
        isMember: true,
      },
      {
        id: 'C2',
        name: 'private-room',
        isPrivate: true,
        isMember: true,
      },
    ]);
    findDiscordInstallationsMock.mockResolvedValue([
      {
        guildId: 'G1',
        guildName: 'Builders',
        channels: [
          {
            channelId: 'D1',
            channelName: 'private-room',
            channelType: 0,
            parentId: null,
          },
        ],
      },
    ]);

    const result = await listCommunicationChannels({ actingUserId: 'user-1' });

    expect(result.channelCount).toBe(0);
    expect(
      result.platforms.find(({ provider }) => provider === 'slack'),
    ).toMatchObject({ channels: [] });
    expect(
      result.platforms.find(({ provider }) => provider === 'discord'),
    ).toMatchObject({ channels: [] });
    expect(createDiscordProviderMock).not.toHaveBeenCalled();
  });
});

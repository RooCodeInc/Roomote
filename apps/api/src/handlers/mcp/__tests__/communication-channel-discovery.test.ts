const {
  findDiscordInstallationsMock,
  findDiscordUserMappingMock,
  findSlackInstallationsMock,
  findTeamsInstallationsMock,
  getCommunicationProviderAdapterMock,
  createDiscordProviderMock,
  listPublicAccessibleChannelIdsMock,
  listPublicChannelsMock,
} = vi.hoisted(() => ({
  findDiscordInstallationsMock: vi.fn(),
  findDiscordUserMappingMock: vi.fn(),
  findSlackInstallationsMock: vi.fn(),
  findTeamsInstallationsMock: vi.fn(),
  getCommunicationProviderAdapterMock: vi.fn(),
  createDiscordProviderMock: vi.fn(),
  listPublicAccessibleChannelIdsMock: vi.fn(),
  listPublicChannelsMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      discordInstallations: { findMany: findDiscordInstallationsMock },
      discordUserMappings: { findFirst: findDiscordUserMappingMock },
      slackInstallations: { findMany: findSlackInstallationsMock },
      teamsInstallations: { findMany: findTeamsInstallationsMock },
    },
  },
  discordInstallationChannels: { isAvailable: 'isAvailable' },
  discordUserMappings: { userId: 'userId' },
  eq: vi.fn(() => 'condition'),
  teamsInstallations: { isActive: 'isActive' },
}));

vi.mock('@roomote/sdk/server', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    createDiscordProviderMock,
  getCommunicationProviderAdapter: getCommunicationProviderAdapterMock,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    listPublicChannels = listPublicChannelsMock;
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
    getCommunicationProviderAdapterMock.mockResolvedValue(null);
    createDiscordProviderMock.mockResolvedValue({
      listPublicAccessibleChannelIds: listPublicAccessibleChannelIdsMock,
    });
    listPublicAccessibleChannelIdsMock.mockImplementation(
      async ({ channelIds }: { channelIds: string[] }) => channelIds,
    );
    listPublicChannelsMock.mockResolvedValue([]);
  });

  it('normalizes discoverable channels and excludes Slack channels the app has not joined', async () => {
    findSlackInstallationsMock.mockResolvedValue([
      { botAccessToken: 'token', teamId: 'T1', teamName: 'Acme' },
    ]);
    listPublicChannelsMock.mockResolvedValue([
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
          {
            channelId: 'D3',
            channelName: 'media',
            channelType: 16,
            parentId: 'category-1',
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
            {
              id: 'D3',
              name: 'media',
              kind: 'forum',
              workspaceId: 'G1',
              workspaceName: 'Builders',
              parentId: 'category-1',
            },
          ],
        },
        {
          provider: 'agentmail',
          platform: 'Email',
          connected: false,
          discoverySupported: false,
          channels: [],
          limitation:
            'Email runs through a single Roomote inbox and conversations are inbound-initiated; there are no enumerable channels.',
        },
      ],
    });
  });

  it('returns app-joined public Slack channels without a linked account', async () => {
    findSlackInstallationsMock.mockResolvedValue([
      { botAccessToken: 'token', teamId: 'T1', teamName: 'Acme' },
    ]);
    listPublicChannelsMock.mockResolvedValue([
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

    expect(result.channelCount).toBe(1);
    expect(
      result.platforms.find(({ provider }) => provider === 'slack'),
    ).toMatchObject({ channels: [{ id: 'C1', name: 'public-room' }] });
    expect(
      result.platforms.find(({ provider }) => provider === 'discord'),
    ).toMatchObject({ channels: [] });
    expect(createDiscordProviderMock).not.toHaveBeenCalled();
  });
});

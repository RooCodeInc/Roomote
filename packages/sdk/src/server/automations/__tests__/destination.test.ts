const {
  mockFindFirstSlackInstallation,
  mockResolveTeamsCredentials,
  mockResolveTelegramCredentials,
  mockTeamsServiceUrlRows,
  mockFindTeamsPrimaryConversation,
  mockFindTelegramPrimaryChatId,
} = vi.hoisted(() => ({
  mockFindFirstSlackInstallation: vi.fn(),
  mockResolveTeamsCredentials: vi.fn(),
  mockResolveTelegramCredentials: vi.fn(),
  mockTeamsServiceUrlRows: vi.fn(),
  mockFindTeamsPrimaryConversation: vi.fn(),
  mockFindTelegramPrimaryChatId: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: { findFirst: mockFindFirstSlackInstallation },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: mockTeamsServiceUrlRows,
        })),
      })),
    })),
  },
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  isNotNull: vi.fn((column: unknown) => ({ isNotNull: column })),
  resolveTeamsBotRuntimeCredentials: mockResolveTeamsCredentials,
  resolveTelegramRuntimeCredentials: mockResolveTelegramCredentials,
  slackInstallations: { id: 'id', isActive: 'isActive' },
  teamsInstallations: {
    conversationId: 'conversationId',
    serviceUrl: 'serviceUrl',
    isActive: 'isActive',
  },
}));

vi.mock('../../lib/teams-primary-conversation', () => ({
  findTeamsPrimaryConversation: mockFindTeamsPrimaryConversation,
}));

vi.mock('../../lib/telegram-primary-chat', () => ({
  findTelegramPrimaryChatId: mockFindTelegramPrimaryChatId,
}));

import {
  buildDestinationPromptContext,
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
} from '../destination';

describe('listConnectedCommunicationProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists providers in waterfall order', async () => {
    mockFindFirstSlackInstallation.mockResolvedValue({ id: 'inst-1' });
    mockResolveTeamsCredentials.mockResolvedValue({
      botAppId: 'app',
      botAppPassword: 'secret',
    });
    mockResolveTelegramCredentials.mockResolvedValue({ botToken: '123:abc' });

    await expect(listConnectedCommunicationProviders()).resolves.toEqual([
      'slack',
      'teams',
      'telegram',
    ]);
  });

  it('returns empty when nothing is connected', async () => {
    mockFindFirstSlackInstallation.mockResolvedValue(undefined);
    mockResolveTeamsCredentials.mockResolvedValue({
      botAppId: null,
      botAppPassword: null,
    });
    mockResolveTelegramCredentials.mockResolvedValue({ botToken: null });

    await expect(listConnectedCommunicationProviders()).resolves.toEqual([]);
  });
});

describe('resolveAutomationRuntimeDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a slack destination as-is', async () => {
    await expect(
      resolveAutomationRuntimeDestination({
        runtime: {
          destination: {
            provider: 'slack',
            channelId: 'C123',
            source: 'manager_channel',
          },
        },
        slackConnected: true,
      }),
    ).resolves.toEqual({
      provider: 'slack',
      channelId: 'C123',
      source: 'manager_channel',
    });
  });

  it('ignores a saved slack destination after Slack disconnects and falls back', async () => {
    mockFindTeamsPrimaryConversation.mockResolvedValue({
      conversationId: '19:primary@thread.v2',
      serviceUrl: 'https://smba.example/amer/',
      conversationType: 'channel',
    });

    await expect(
      resolveAutomationRuntimeDestination({
        runtime: {
          destination: {
            provider: 'slack',
            channelId: 'C123',
            source: 'manager_channel',
          },
        },
        slackConnected: false,
      }),
    ).resolves.toEqual({
      provider: 'teams',
      channelId: '19:primary@thread.v2',
      serviceUrl: 'https://smba.example/amer/',
      source: 'primary_conversation',
    });
  });

  it('resolves the serviceUrl for a teams destination', async () => {
    mockTeamsServiceUrlRows.mockResolvedValue([
      { serviceUrl: 'https://smba.example/amer/' },
    ]);

    await expect(
      resolveAutomationRuntimeDestination({
        runtime: {
          destination: {
            provider: 'teams',
            channelId: '19:conv@thread.v2',
            source: 'automation_target',
          },
        },
        slackConnected: false,
      }),
    ).resolves.toEqual({
      provider: 'teams',
      channelId: '19:conv@thread.v2',
      serviceUrl: 'https://smba.example/amer/',
      source: 'automation_target',
    });
  });

  it('returns null for a teams destination with no resolvable serviceUrl', async () => {
    mockTeamsServiceUrlRows.mockResolvedValue([]);

    await expect(
      resolveAutomationRuntimeDestination({
        runtime: {
          destination: {
            provider: 'teams',
            channelId: '19:conv@thread.v2',
            source: 'automation_target',
          },
        },
        slackConnected: false,
      }),
    ).resolves.toBeNull();
  });

  it('keeps the manager-channel nudge on Slack deployments without a destination', async () => {
    await expect(
      resolveAutomationRuntimeDestination({
        runtime: { destination: null },
        slackConnected: true,
      }),
    ).resolves.toBeNull();
    expect(mockFindTeamsPrimaryConversation).not.toHaveBeenCalled();
  });

  it('falls back to the primary Teams conversation on Slack-less deployments', async () => {
    mockFindTeamsPrimaryConversation.mockResolvedValue({
      conversationId: '19:primary@thread.v2',
      serviceUrl: 'https://smba.example/amer/',
      conversationType: 'channel',
    });

    await expect(
      resolveAutomationRuntimeDestination({
        runtime: { destination: null },
        slackConnected: false,
      }),
    ).resolves.toEqual({
      provider: 'teams',
      channelId: '19:primary@thread.v2',
      serviceUrl: 'https://smba.example/amer/',
      source: 'primary_conversation',
    });
  });

  it('falls back to the Telegram primary chat after Teams', async () => {
    mockFindTeamsPrimaryConversation.mockResolvedValue(null);
    mockFindTelegramPrimaryChatId.mockResolvedValue('-100123');

    await expect(
      resolveAutomationRuntimeDestination({
        runtime: { destination: null },
        slackConnected: false,
      }),
    ).resolves.toEqual({
      provider: 'telegram',
      channelId: '-100123',
      source: 'primary_conversation',
    });
  });
});

describe('payload fields and prompt context', () => {
  it('stamps nothing for slack destinations', () => {
    expect(
      buildDestinationTaskPayloadFields({
        provider: 'slack',
        channelId: 'C123',
        source: 'manager_channel',
      }),
    ).toEqual({});
  });

  it('stamps communication fields for teams destinations', () => {
    expect(
      buildDestinationTaskPayloadFields({
        provider: 'teams',
        channelId: '19:conv@thread.v2',
        serviceUrl: 'https://smba.example/amer/',
        source: 'automation_target',
      }),
    ).toEqual({
      communicationProvider: 'teams',
      communicationChannelId: '19:conv@thread.v2',
      communicationServiceUrl: 'https://smba.example/amer/',
    });
  });

  it('builds surface-correct prompt context', () => {
    expect(
      buildDestinationPromptContext({
        provider: 'slack',
        channelId: 'C1',
        source: 'manager_channel',
      }),
    ).toEqual({
      channelTag: 'slack_channel_id',
      postToolName: 'post_to_slack_channel',
      surfaceLabel: 'Slack',
    });
    expect(
      buildDestinationPromptContext({
        provider: 'telegram',
        channelId: '1',
        source: 'automation_target',
      }),
    ).toEqual({
      channelTag: 'channel_id',
      postToolName: 'post_to_channel',
      surfaceLabel: 'Telegram',
    });
  });
});

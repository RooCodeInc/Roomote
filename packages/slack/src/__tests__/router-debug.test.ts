const {
  chatPostMessageMock,
  descMock,
  discordPostMessageMock,
  findFirstMock,
  getDebugChannelMock,
  resolveDiscordCredentialsMock,
  resolveTeamsCredentialsMock,
  selectLimitMock,
  teamsFactoryMock,
  teamsPostMessageMock,
} = vi.hoisted(() => ({
  chatPostMessageMock: vi.fn(),
  descMock: vi.fn((value: unknown) => ({ desc: value })),
  discordPostMessageMock: vi.fn(),
  findFirstMock: vi.fn(),
  getDebugChannelMock: vi.fn(),
  resolveDiscordCredentialsMock: vi.fn(),
  resolveTeamsCredentialsMock: vi.fn(),
  selectLimitMock: vi.fn(),
  teamsFactoryMock: vi.fn(),
  teamsPostMessageMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: {
    ROUTER_DEBUG_CHANNEL_ID: 'CDEBUG',
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: {
        findFirst: findFirstMock,
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimitMock })),
      })),
    })),
  },
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: descMock,
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  getConfiguredRouterDebugDestination: getDebugChannelMock,
  isNotNull: vi.fn((value: unknown) => ({ isNotNull: value })),
  resolveDiscordRuntimeCredentials: resolveDiscordCredentialsMock,
  resolveTeamsBotRuntimeCredentials: resolveTeamsCredentialsMock,
  resolveTelegramRuntimeCredentials: vi.fn(),
  slackInstallations: {
    isActive: 'isActive',
    updatedAt: 'updatedAt',
  },
  teamsInstallations: {
    conversationId: 'conversationId',
    isActive: 'isActive',
    serviceUrl: 'serviceUrl',
  },
}));

vi.mock('@roomote/communication/discord-provider', () => ({
  DiscordCommunicationProvider: vi.fn(function MockDiscordProvider() {
    return { postMessage: discordPostMessageMock };
  }),
}));

vi.mock('@roomote/communication/teams-provider', () => ({
  createTeamsCommunicationProviderFromEnv: teamsFactoryMock,
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: vi.fn(),
}));

vi.mock('../web-client', () => ({
  createSlackWebClient: vi.fn(() => ({
    chat: {
      postMessage: chatPostMessageMock,
    },
  })),
}));

import { postRouterDebugMessage, postRouterDebugText } from '../router-debug';

describe('postRouterDebugMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getDebugChannelMock.mockResolvedValue({
      provider: 'slack',
      channelId: 'CDEBUG',
    });
    findFirstMock.mockResolvedValue({ botAccessToken: 'xoxb-token' });
    chatPostMessageMock.mockResolvedValue({ ok: true });
    discordPostMessageMock.mockResolvedValue({
      provider: 'discord',
      channelId: '123',
      messageId: '456',
    });
    resolveDiscordCredentialsMock.mockResolvedValue({
      botToken: 'discord-token',
      applicationId: 'discord-app',
    });
    resolveTeamsCredentialsMock.mockResolvedValue({
      botAppId: 'teams-app',
      botAppPassword: 'teams-secret',
      botTenantId: 'teams-tenant',
      botTokenEndpoint: 'https://login.example.test/token',
      botOauthScope: 'https://bot.example.test/.default',
    });
    selectLimitMock.mockResolvedValue([
      { serviceUrl: 'https://smba.trafficmanager.net/amer' },
    ]);
    teamsFactoryMock.mockReturnValue({ postMessage: teamsPostMessageMock });
    teamsPostMessageMock.mockResolvedValue({
      provider: 'teams',
      channelId: '19:conversation',
      messageId: 'activity-id',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes routed environment details in debug channel messages', async () => {
    await postRouterDebugMessage({
      source: 'Slack C123',
      sourceLink:
        'https://app.slack.com/archives/C123/p123456?thread_ts=123.456&cid=C123',
      taskDescription: 'Use GPT 5.4 for this one.',
      selectedWorkspace: { name: 'App', type: 'environment' },
      reasoning: 'App is the best fit.',
      routingDebug: {
        phase: 'direct',
        toolsUsed: [],
        needsExternalLookup: false,
        confidence: 0.97,
        workspaceRemapped: false,
      },
    });

    expect(chatPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'CDEBUG',
        text: 'Router | Slack C123',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '🔍 *Router* | <https://app.slack.com/archives/C123/p123456?thread_ts=123.456&cid=C123|Slack C123>',
              ),
            }),
          }),
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '• *Environment:* App — confidence 0.97',
              ),
            }),
          }),
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '*Message*\n> Use GPT 5.4 for this one.',
              ),
            }),
          }),
        ]),
      }),
    );
    expect(descMock).toHaveBeenCalledWith('updatedAt');
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ desc: 'updatedAt' }] }),
    );
  });

  it('includes full routing diagnostics for non-Slack destinations', async () => {
    getDebugChannelMock.mockResolvedValue({
      provider: 'discord',
      channelId: '123',
    });

    await postRouterDebugMessage({
      source: 'Discord 123',
      sourceLink: 'https://discord.com/channels/1/123/456',
      taskDescription: 'Use GPT 5.4 for this one.',
      selectedWorkspace: { name: 'App', type: 'environment' },
      reasoning: 'App is the best fit.',
      routingDurationMs: 420,
      routingDebug: {
        phase: 'direct',
        toolsUsed: ['search_workspaces', 'submit_routing_decision'],
        needsExternalLookup: true,
        confidence: 0.97,
        workspaceRemapped: true,
      },
    });

    expect(discordPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '123',
        text: expect.stringContaining(
          'Source: [Discord 123](https://discord.com/channels/1/123/456)',
        ),
      }),
    );
    const text = discordPostMessageMock.mock.calls[0]?.[0]?.text as string;
    expect(text).toContain('Environment: App — confidence 0.97');
    expect(text).toContain('Environment remapped:');
    expect(text).toContain('Duration: 420ms');
    expect(text).toContain('Tools: `search_workspaces`');
    expect(text).not.toContain('submit_routing_decision');
  });

  it('preserves Teams token endpoint and OAuth scope overrides', async () => {
    getDebugChannelMock.mockResolvedValue({
      provider: 'teams',
      channelId: '19:conversation',
    });

    await postRouterDebugText('Router diagnostic');

    expect(teamsFactoryMock).toHaveBeenCalledWith({
      R_TEAMS_BOT_APP_ID: 'teams-app',
      R_TEAMS_BOT_APP_PASSWORD: 'teams-secret',
      R_TEAMS_BOT_TENANT_ID: 'teams-tenant',
      R_TEAMS_BOT_TOKEN_ENDPOINT: 'https://login.example.test/token',
      R_TEAMS_BOT_OAUTH_SCOPE: 'https://bot.example.test/.default',
    });
    expect(teamsPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '19:conversation',
        serviceUrl: 'https://smba.trafficmanager.net/amer',
      }),
    );
  });
});

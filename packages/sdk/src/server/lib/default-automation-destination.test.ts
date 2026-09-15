import type { DatabaseOrTransaction } from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  installations: vi.fn(),
  membership: vi.fn(),
  discord: vi.fn(),
  discordPrimary: vi.fn(),
  teams: vi.fn(),
  teamsPrimary: vi.fn(),
  telegramPrimary: vi.fn(),
  teamsCredentials: vi.fn(),
  telegramCredentials: vi.fn(),
  discordCredentials: vi.fn(),
  connectedProviders: vi.fn(),
  directMessage: vi.fn(),
  emailIdentities: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { deploymentSettings: { findFirst: mocks.settings } },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: mocks.installations }),
        }),
      }),
    }),
  },
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  deploymentSettings: { id: 'settings.id' },
  slackInstallations: {
    id: 'installation.id',
    botAccessToken: 'installation.token',
    isActive: 'installation.active',
    teamId: 'installation.team',
  },
  slackInstallationChannels: {
    slackInstallationId: 'channel.installation',
    channelId: 'channel.id',
  },
  resolveTeamsBotRuntimeCredentials: mocks.teamsCredentials,
  resolveTelegramRuntimeCredentials: mocks.telegramCredentials,
  resolveDiscordRuntimeCredentials: mocks.discordCredentials,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    isAppInChannel = mocks.membership;
  },
}));
vi.mock('./discord-persistence', () => ({
  findDiscordDestinationByChannelId: mocks.discord,
  findDiscordDefaultDestination: mocks.discordPrimary,
}));
vi.mock('./teams-primary-conversation', () => ({
  findTeamsPrimaryConversation: mocks.teamsPrimary,
}));
vi.mock('./telegram-primary-chat', () => ({
  findTelegramPrimaryChatId: mocks.telegramPrimary,
}));
vi.mock('../automations/destination', () => ({
  findTeamsConversationRoute: mocks.teams,
  listConnectedCommunicationProviders: mocks.connectedProviders,
}));
vi.mock('./agentmail/outbound', () => ({
  listAvailableAgentMailOutboundIdentities: mocks.emailIdentities,
}));
vi.mock('./user-direct-message', () => ({
  findUserDirectMessageDestination: mocks.directMessage,
}));

import {
  CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
  resolveDefaultAutomationTarget,
} from './default-automation-destination';

describe('resolveDefaultAutomationTarget', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.settings.mockResolvedValue({ setupNewState: {} });
    mocks.installations.mockResolvedValue([]);
    mocks.membership.mockResolvedValue(false);
    mocks.discord.mockResolvedValue(null);
    mocks.discordPrimary.mockResolvedValue(null);
    mocks.discordCredentials.mockResolvedValue({ botToken: 'token' });
    mocks.connectedProviders.mockResolvedValue([
      'slack',
      'teams',
      'telegram',
      'discord',
    ]);
    mocks.directMessage.mockResolvedValue(null);
    mocks.teams.mockResolvedValue(null);
    mocks.teamsPrimary.mockResolvedValue(null);
    mocks.telegramPrimary.mockResolvedValue(null);
    mocks.teamsCredentials.mockResolvedValue({
      botAppId: 'app',
      botAppPassword: 'password',
    });
    mocks.telegramCredentials.mockResolvedValue({ botToken: 'token' });
    mocks.emailIdentities.mockResolvedValue([]);
  });

  it('prefers a usable configured channel over owner DM and Email', async () => {
    mocks.settings.mockResolvedValue({
      managerSlackChannelId: ' C12345678 ',
      setupNewState: {},
    });
    mocks.installations.mockResolvedValue([
      { botAccessToken: 'token', teamId: 'T123' },
    ]);
    mocks.membership.mockResolvedValue(true);
    mocks.directMessage.mockResolvedValue({ channelId: 'D123' });
    mocks.emailIdentities.mockResolvedValue([{ id: 'verified:user:hash' }]);

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
      }),
    ).resolves.toEqual({
      provider: 'slack',
      targetKind: 'slack_channel',
      externalRef: 'C12345678',
      metadata: { slackTeamId: 'T123' },
    });
    expect(mocks.directMessage).not.toHaveBeenCalled();
    expect(mocks.emailIdentities).not.toHaveBeenCalled();
  });

  it('continues after stale channels and unavailable DM providers', async () => {
    mocks.settings.mockResolvedValue({
      managerSlackChannelId: 'CSTALE123',
      managerDiscordChannelId: 'discord-stale',
      setupNewState: {},
    });
    mocks.directMessage
      .mockRejectedValueOnce(new Error('stale Slack link'))
      .mockResolvedValueOnce({
        channelId: 'teams-conversation',
        serviceUrl: 'https://teams.example.test',
      });

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
      }),
    ).resolves.toEqual({
      provider: 'teams',
      targetKind: 'teams_user',
      externalRef: 'user-1',
    });
  });

  it('skips stale DM mappings for disconnected providers', async () => {
    mocks.connectedProviders.mockResolvedValue(['slack']);
    mocks.directMessage.mockResolvedValue(null);
    mocks.emailIdentities.mockResolvedValue([{ id: 'verified:user:hash' }]);

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
      }),
    ).resolves.toMatchObject({ provider: 'email' });
    expect(mocks.directMessage).toHaveBeenCalledTimes(1);
    expect(mocks.directMessage).toHaveBeenCalledWith('slack', 'user-1');
  });

  it('uses a primary conversation before an owner DM', async () => {
    mocks.teamsPrimary.mockResolvedValue({
      conversationId: 'teams-channel',
      serviceUrl: 'https://teams.example.test',
    });
    mocks.teams.mockResolvedValue({
      workspaceId: 'tenant-1',
      serviceUrl: 'https://teams.example.test',
    });
    mocks.directMessage.mockResolvedValue({ channelId: 'D123' });

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
      }),
    ).resolves.toEqual({
      provider: 'teams',
      targetKind: 'teams_channel',
      externalRef: 'teams-channel',
      metadata: { serviceUrl: 'https://teams.example.test' },
    });
    expect(mocks.directMessage).not.toHaveBeenCalled();
  });

  it('skips shared channel defaults for member-owned automation options', async () => {
    mocks.settings.mockResolvedValue({
      managerSlackChannelId: 'C12345678',
      setupNewState: {},
    });
    mocks.teamsPrimary.mockResolvedValue({
      conversationId: 'teams-channel',
      serviceUrl: 'https://teams.example.test',
    });
    mocks.directMessage.mockResolvedValue({ channelId: 'D123' });

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
        includeSharedChannels: false,
      }),
    ).resolves.toEqual({
      provider: 'slack',
      targetKind: 'slack_user',
      externalRef: 'user-1',
    });
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.teamsPrimary).not.toHaveBeenCalled();
  });

  it('preserves a supported explicit target without probing defaults', async () => {
    const explicit = {
      provider: 'discord' as const,
      targetKind: 'discord_channel' as const,
      externalRef: 'explicit-channel',
    };

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
        existingTarget: explicit,
      }),
    ).resolves.toBe(explicit);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.directMessage).not.toHaveBeenCalled();
  });

  it('does not select Email when the runner does not support it', async () => {
    mocks.emailIdentities.mockResolvedValue([{ id: 'verified:user:hash' }]);

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: { chatProviders: ['slack'], email: false },
      }),
    ).resolves.toBeNull();
    expect(mocks.emailIdentities).not.toHaveBeenCalled();
  });

  it('uses verified Email only after chat candidates are exhausted', async () => {
    mocks.emailIdentities.mockResolvedValue([{ id: 'verified:user:hash' }]);

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
      }),
    ).resolves.toEqual({
      provider: 'email',
      targetKind: 'email_user',
      externalRef: 'user-1',
      metadata: { emailIdentityId: 'verified:user:hash' },
    });
  });

  it('returns null when no supported destination is usable', async () => {
    const findFirst = vi.fn().mockResolvedValue({ setupNewState: {} });
    const client = {
      query: { deploymentSettings: { findFirst } },
    } as unknown as DatabaseOrTransaction;

    await expect(
      resolveDefaultAutomationTarget({
        ownerUserId: 'user-1',
        capabilities: CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES,
        client,
      }),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });
});

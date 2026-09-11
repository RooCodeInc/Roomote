import type { DatabaseOrTransaction } from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  installations: vi.fn(),
  membership: vi.fn(),
  discord: vi.fn(),
  teams: vi.fn(),
  teamsCredentials: vi.fn(),
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
  resolveDiscordRuntimeCredentials: mocks.discordCredentials,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    isAppInChannel = mocks.membership;
  },
}));
vi.mock('./discord-persistence', () => ({
  findDiscordDestinationByChannelId: mocks.discord,
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

import { resolveSetupAutomationReportTarget } from './setup-automation-delivery';

describe('resolveSetupAutomationReportTarget', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.settings.mockResolvedValue({ setupNewState: {} });
    mocks.installations.mockResolvedValue([]);
    mocks.membership.mockResolvedValue(false);
    mocks.discord.mockResolvedValue(null);
    mocks.discordCredentials.mockResolvedValue({ botToken: 'token' });
    mocks.connectedProviders.mockResolvedValue([]);
    mocks.directMessage.mockResolvedValue(null);
    mocks.teams.mockResolvedValue(null);
    mocks.teamsCredentials.mockResolvedValue({
      botAppId: 'app',
      botAppPassword: 'password',
    });
    mocks.emailIdentities.mockResolvedValue([]);
  });

  it('prefers a usable configured chat destination over Email', async () => {
    mocks.settings.mockResolvedValue({
      managerSlackChannelId: ' C123 ',
      setupNewState: {},
    });
    mocks.installations.mockResolvedValue([
      { botAccessToken: 'token', teamId: 'T123' },
    ]);
    mocks.membership.mockResolvedValue(true);
    mocks.emailIdentities.mockResolvedValue([
      { id: 'verified:user:hash', emailAddress: 'user@example.com' },
    ]);

    await expect(resolveSetupAutomationReportTarget('user-1')).resolves.toEqual(
      {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'C123',
        metadata: { slackTeamId: 'T123' },
      },
    );
    expect(mocks.emailIdentities).not.toHaveBeenCalled();
  });

  it('uses Email when no usable chat destination exists', async () => {
    mocks.emailIdentities.mockResolvedValue([
      { id: 'verified:user:hash', emailAddress: 'user@example.com' },
    ]);

    await expect(resolveSetupAutomationReportTarget('user-1')).resolves.toEqual(
      {
        provider: 'email',
        targetKind: 'email_user',
        externalRef: 'user-1',
        metadata: { emailIdentityId: 'verified:user:hash' },
      },
    );
  });

  it('prefers a usable chat direct message over Email', async () => {
    mocks.connectedProviders.mockResolvedValue(['teams']);
    mocks.directMessage.mockResolvedValue({
      channelId: 'conversation-1',
      serviceUrl: 'https://teams.example.test',
    });
    mocks.emailIdentities.mockResolvedValue([
      { id: 'verified:user:hash', emailAddress: 'user@example.com' },
    ]);

    await expect(resolveSetupAutomationReportTarget('user-1')).resolves.toEqual(
      {
        provider: 'teams',
        targetKind: 'teams_user',
        externalRef: 'user-1',
      },
    );
    expect(mocks.emailIdentities).not.toHaveBeenCalled();
  });

  it('falls back to Email when configured chat is unavailable', async () => {
    mocks.settings.mockResolvedValue({
      managerDiscordChannelId: '123',
      setupNewState: {},
    });
    mocks.emailIdentities.mockResolvedValue([
      { id: 'verified:user:hash', emailAddress: 'user@example.com' },
    ]);

    await expect(
      resolveSetupAutomationReportTarget('user-1'),
    ).resolves.toMatchObject({ provider: 'email' });
  });

  it('returns null when neither chat nor Email is available', async () => {
    await expect(
      resolveSetupAutomationReportTarget('user-1'),
    ).resolves.toBeNull();
  });

  it('uses the supplied transaction for setup settings', async () => {
    const findFirst = vi.fn().mockResolvedValue({ setupNewState: {} });
    const client = {
      query: { deploymentSettings: { findFirst } },
    } as unknown as DatabaseOrTransaction;

    await resolveSetupAutomationReportTarget('user-1', client);

    expect(findFirst).toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });
});

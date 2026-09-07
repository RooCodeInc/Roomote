import type { DatabaseOrTransaction } from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  installations: vi.fn(),
  where: vi.fn(),
  join: vi.fn(),
  notifier: vi.fn(),
  membership: vi.fn(),
  discord: vi.fn(),
  teams: vi.fn(),
  teamsCredentials: vi.fn(),
  discordCredentials: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { deploymentSettings: { findFirst: mocks.settings } },
    select: () => ({
      from: () => ({
        innerJoin: (...args: unknown[]) => {
          mocks.join(...args);
          return {
            where: (...conditions: unknown[]) => {
              mocks.where(...conditions);
              return { limit: mocks.installations };
            },
          };
        },
      }),
    }),
  },
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  deploymentSettings: { id: 'settings.id' },
  slackInstallations: {
    id: 'installation.id',
    isActive: 'active',
    teamId: 'team',
  },
  slackInstallationChannels: {
    slackInstallationId: 'owner',
    channelId: 'channel',
  },
  resolveTeamsBotRuntimeCredentials: mocks.teamsCredentials,
  resolveDiscordRuntimeCredentials: mocks.discordCredentials,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    constructor(token: string) {
      mocks.notifier(token);
    }
    isAppInChannel = mocks.membership;
  },
}));
vi.mock('./discord-persistence', () => ({
  findDiscordDestinationByChannelId: mocks.discord,
}));
vi.mock('../automations/destination', () => ({
  findTeamsConversationRoute: mocks.teams,
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
    mocks.teams.mockResolvedValue(null);
    mocks.teamsCredentials.mockResolvedValue({
      botAppId: 'app',
      botAppPassword: 'password',
    });
  });

  it('returns null with no communication configuration', async () => {
    await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.discord).not.toHaveBeenCalled();
    expect(mocks.teams).not.toHaveBeenCalled();
  });

  it('does not select a destination just because providers are connected', async () => {
    mocks.installations.mockResolvedValue([{ botAccessToken: 'token' }]);
    mocks.discord.mockResolvedValue({ channelId: 'arbitrary' });
    mocks.teams.mockResolvedValue({
      serviceUrl: 'https://example.test',
      workspaceId: 'tenant',
    });
    await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
    expect(mocks.installations).not.toHaveBeenCalled();
    expect(mocks.discord).not.toHaveBeenCalled();
    expect(mocks.teams).not.toHaveBeenCalled();
  });

  it('uses the supplied client for locked setup settings', async () => {
    const findFirst = vi.fn().mockResolvedValue(undefined);
    const client = {
      query: { deploymentSettings: { findFirst } },
    } as unknown as DatabaseOrTransaction;
    await expect(
      resolveSetupAutomationReportTarget(client),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it('prefers and normalizes the manager Slack channel with the owning installation token', async () => {
    mocks.settings.mockResolvedValue({
      managerSlackChannelId: ' C123 ',
      managerDiscordChannelId: '123',
      setupNewState: {},
    });
    mocks.installations.mockResolvedValue([{ botAccessToken: 'owning-token' }]);
    mocks.membership.mockResolvedValue(true);
    await expect(resolveSetupAutomationReportTarget()).resolves.toEqual({
      provider: 'slack',
      targetKind: 'slack_channel',
      externalRef: 'C123',
    });
    expect(mocks.notifier).toHaveBeenCalledWith('owning-token');
    expect(mocks.membership).toHaveBeenCalledWith('C123');
    expect(mocks.join.mock.calls[0]?.[1]).toEqual([
      ['owner', 'installation.id'],
      ['channel', 'C123'],
    ]);
    expect(mocks.where).toHaveBeenCalledWith([['active', true]]);
    expect(mocks.discord).not.toHaveBeenCalled();
  });

  it.each([false, null])(
    'rejects inaccessible/unknown Slack membership (%s)',
    async (membership) => {
      mocks.settings.mockResolvedValue({ managerSlackChannelId: 'C123' });
      mocks.installations.mockResolvedValue([{ botAccessToken: 'token' }]);
      mocks.membership.mockResolvedValue(membership);
      await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
    },
  );

  it.each([
    { installations: [] },
    { installations: [{ botAccessToken: 'one' }, { botAccessToken: 'two' }] },
  ])(
    'rejects missing or ambiguous active Slack owners',
    async ({ installations }) => {
      mocks.settings.mockResolvedValue({ managerSlackChannelId: 'C123' });
      mocks.installations.mockResolvedValue(installations);
      await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
      expect(mocks.membership).not.toHaveBeenCalled();
    },
  );

  it('checks the exact workspace for legacy Slack handoffs', async () => {
    mocks.settings.mockResolvedValue({
      setupNewState: { slackChannel: 'C123', slackTeamId: 'T123' },
    });
    mocks.installations.mockResolvedValue([{ botAccessToken: 'token' }]);
    mocks.membership.mockResolvedValue(true);
    await expect(resolveSetupAutomationReportTarget()).resolves.toEqual({
      provider: 'slack',
      targetKind: 'slack_channel',
      externalRef: 'C123',
    });
    expect(mocks.where).toHaveBeenCalledWith([
      ['active', true],
      ['team', 'T123'],
    ]);
  });

  it.each([
    { slackChannel: 'D123', slackTeamId: 'T123' },
    { slackChannel: 'C123' },
  ])('omits DM or unscoped Slack handoffs', async (setupNewState) => {
    mocks.settings.mockResolvedValue({ setupNewState });
    await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
    expect(mocks.membership).not.toHaveBeenCalled();
  });

  it('prefers the configured Discord destination over a setup handoff', async () => {
    mocks.settings.mockResolvedValue({
      managerDiscordChannelId: ' 123 ',
      setupNewState: {
        chatHandoffProvider: 'teams',
        chatHandoffChannelId: 'conversation',
      },
    });
    mocks.discord.mockResolvedValue({
      channelId: '123',
      installationId: 'installation',
    });
    await expect(resolveSetupAutomationReportTarget()).resolves.toEqual({
      provider: 'discord',
      targetKind: 'discord_channel',
      externalRef: '123',
    });
    expect(mocks.discord).toHaveBeenCalledWith('123');
    expect(mocks.teams).not.toHaveBeenCalled();
  });

  it('rejects stale/unavailable Discord configuration', async () => {
    mocks.settings.mockResolvedValue({ managerDiscordChannelId: '123' });
    await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
  });

  it('rejects a disconnected Discord bot even with an available channel', async () => {
    mocks.settings.mockResolvedValue({ managerDiscordChannelId: '123' });
    mocks.discord.mockResolvedValue({ channelId: '123' });
    mocks.discordCredentials.mockResolvedValue({ botToken: null });
    await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
    expect(mocks.discord).not.toHaveBeenCalled();
  });

  it('validates the exact persisted Discord handoff rather than a default', async () => {
    mocks.settings.mockResolvedValue({
      setupNewState: {
        chatHandoffProvider: 'discord',
        chatHandoffChannelId: '123',
      },
    });
    mocks.discord.mockResolvedValue({
      channelId: '123',
      installationId: 'installation',
    });
    await expect(resolveSetupAutomationReportTarget()).resolves.toEqual({
      provider: 'discord',
      targetKind: 'discord_channel',
      externalRef: '123',
    });
    expect(mocks.discord).toHaveBeenCalledWith('123');
  });

  it('propagates only the current Teams route service URL in the persisted target shape', async () => {
    mocks.settings.mockResolvedValue({
      setupNewState: {
        chatHandoffProvider: 'teams',
        chatHandoffChannelId: 'conversation',
        chatHandoffServiceUrl: 'https://stale.test',
        chatHandoffThreadId: 'old-thread',
      },
    });
    mocks.teams.mockResolvedValue({
      serviceUrl: 'https://current.test',
      workspaceId: 'tenant',
    });
    await expect(resolveSetupAutomationReportTarget()).resolves.toEqual({
      provider: 'teams',
      targetKind: 'teams_channel',
      externalRef: 'conversation',
      metadata: { serviceUrl: 'https://current.test' },
    });
    expect(mocks.teams).toHaveBeenCalledWith('conversation');
  });

  it.each([null, { serviceUrl: '', workspaceId: 'tenant' }])(
    'rejects absent/stale Teams routes',
    async (route) => {
      mocks.settings.mockResolvedValue({
        setupNewState: {
          chatHandoffProvider: 'teams',
          chatHandoffChannelId: 'conversation',
          chatHandoffServiceUrl: 'https://stale.test',
        },
      });
      mocks.teams.mockResolvedValue(route);
      await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
    },
  );

  it('rejects a disconnected Teams bot even with a persisted route', async () => {
    mocks.settings.mockResolvedValue({
      setupNewState: {
        chatHandoffProvider: 'teams',
        chatHandoffChannelId: 'conversation',
      },
    });
    mocks.teamsCredentials.mockResolvedValue({
      botAppId: null,
      botAppPassword: null,
    });
    await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
    expect(mocks.teams).not.toHaveBeenCalled();
  });

  it('fails closed for Telegram handoffs without an active bot-bound installation', async () => {
    mocks.settings.mockResolvedValue({
      setupNewState: {
        chatHandoffProvider: 'telegram',
        chatHandoffChannelId: '123',
      },
    });
    await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
  });

  it('fails closed without logging a validation error', async () => {
    const warn = vi.spyOn(console, 'warn');
    mocks.settings.mockRejectedValue(new Error('sensitive validation failure'));
    await expect(resolveSetupAutomationReportTarget()).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

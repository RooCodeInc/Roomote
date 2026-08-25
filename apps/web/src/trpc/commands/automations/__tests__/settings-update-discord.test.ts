import {
  automations,
  db,
  deploymentSettings,
  discordInstallationChannels,
  discordInstallations,
  eq,
  slackInstallations,
  upsertAutomation,
  users,
} from '@roomote/db/server';
import type { BackgroundAutomationKey } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { updateBackgroundAgentSettingsCommand } from '../settings-update';
import type { UpdateBackgroundAgentSettingsInput } from '../types';

const mockCaptureActivationAutomationChanged = vi.hoisted(() => vi.fn());

vi.mock('@roomote/telemetry/server', () => ({
  captureActivationAutomationChanged: mockCaptureActivationAutomationChanged,
}));

// Keep the test hermetic: the command constructs a SlackNotifier whenever a
// Slack installation exists and probes channel membership/names after saving.
vi.mock('@roomote/slack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/slack')>();

  class MockSlackNotifier {
    constructor(_token: string) {}

    async isAppInChannel() {
      return true;
    }

    async getChannelName() {
      return null;
    }

    async resolveChannelId() {
      return null;
    }

    async listAccessibleChannels() {
      return [];
    }
  }

  return { ...actual, SlackNotifier: MockSlackNotifier };
});

const adminAuth: UserAuthSuccess = {
  success: true,
  userType: 'user',
  userId: 'user-admin',
  name: 'Admin',
  primaryEmail: 'admin@example.com',
  isAdmin: true,
  featureFlags: {},
  anonymousAnalyticsEnabled: false,
  cloudEnabled: false,
  cookieConsentedAt: null,
  resource: {
    username: null,
    fullName: null,
    firstName: null,
    lastName: null,
    primaryEmailAddress: null,
    emailAddresses: [],
    imageUrl: '',
    createdAt: null,
  },
};

function buildInput(
  overrides: Partial<UpdateBackgroundAgentSettingsInput> = {},
): UpdateBackgroundAgentSettingsInput {
  return {
    savingAutomation: 'managerStats',
    reviewerEnabled: false,
    reviewerEnvironmentScope: 'all',
    reviewerEnvironmentIds: [],
    reviewerAuthorReviewMode: 'specific',
    reviewerCollaborators: [],
    reviewerExcludedAuthors: null,
    reviewerReviewAllPullRequestAuthors: false,
    reviewerReviewOnCommit: true,
    reviewerReviewDraftPrs: true,
    reviewerRelayReviewResultsToTask: false,
    reviewerRelayUserIds: [],
    conflictResolverFrequency: 'off',
    conflictResolverLabel: 'roomote:auto-resolve-conflicts',
    conflictResolverInstructions: null,
    channelAutoStartSlackChannels: [],
    managerSlackChannel: null,
    managerDiscordChannel: null,
    managerStatsFrequency: 'off',
    managerStatsSlackChannel: null,
    managerStatsDiscordChannel: null,
    sentryTriageFrequency: 'off',
    sentryTriageSlackChannel: null,
    sentryTriageDiscordChannel: null,
    sentryTriageProjectSlugs: null,
    dependabotTriageFrequency: 'off',
    dependabotTriageSlackChannel: null,
    dependabotTriageDiscordChannel: null,
    codeqlTriageFrequency: 'off',
    codeqlTriageSlackChannel: null,
    codeqlTriageDiscordChannel: null,
    issueFixerFrequency: 'off',
    issueFixerInstructions: null,

    securityAuditorFrequency: 'off',
    securityAuditorSlackChannel: null,
    securityAuditorDiscordChannel: null,
    codeQualityAuditorFrequency: 'off',
    codeQualityAuditorSlackChannel: null,
    codeQualityAuditorDiscordChannel: null,
    ciFailureTriageFrequency: 'off',
    ciFailureTriageSlackChannel: null,
    ciFailureTriageDiscordChannel: null,
    suggesterFrequency: 'off',
    suggesterSlackChannel: null,
    suggesterDiscordChannel: null,
    suggesterInstructions: null,
    announcerFrequency: 'off',
    announcerSlackChannel: null,
    announcerDiscordChannel: null,
    announcerInstructions: null,
    platformIssueAlertsEnabled: true,
    platformIssueSlackChannel: null,
    platformIssueDiscordChannel: null,
    ...overrides,
  };
}

async function insertAvailableDiscordChannel(params: {
  guildId: string;
  channelId: string;
  channelName: string;
  channelType?: number;
}) {
  const [installation] = await db
    .insert(discordInstallations)
    .values({
      guildId: params.guildId,
      guildName: 'Acme',
      applicationId: 'app-1',
      botUserId: 'bot-1',
      isActive: true,
    })
    .returning();

  if (!installation) {
    throw new Error('Failed to insert Discord installation fixture.');
  }

  await db.insert(discordInstallationChannels).values({
    discordInstallationId: installation.id,
    channelId: params.channelId,
    channelName: params.channelName,
    channelType: params.channelType ?? 0,
    isAvailable: true,
  });
}

async function insertSlackInstallation() {
  await db.insert(users).values({
    id: 'user-admin',
    name: 'Admin',
    email: 'admin@example.com',
    imageUrl: '',
    entity: {},
  });

  await db.insert(slackInstallations).values({
    teamId: 'T123',
    teamName: 'Acme',
    appId: 'A123',
    botUserId: 'B123',
    botAccessToken: 'xoxb-test',
    scopes: { bot: ['channels:read', 'groups:read'] },
    installedByUserId: 'user-admin',
    isActive: true,
  });
}

async function getAutomationTargets(key: BackgroundAutomationKey) {
  const automation = await db.query.automations.findFirst({
    where: eq(automations.key, key),
  });

  return (automation?.targets ?? []).map(
    ({ provider, targetKind, externalRef }) => ({
      provider,
      targetKind,
      externalRef,
    }),
  );
}

describe('updateBackgroundAgentSettingsCommand Discord destinations', () => {
  beforeEach(async () => {
    mockCaptureActivationAutomationChanged.mockClear();
    await db.delete(automations);
    await db.delete(deploymentSettings);
    await db.delete(discordInstallations);
    await db.delete(slackInstallations);
    await db.delete(users).where(eq(users.id, adminAuth.userId));
  });

  it('tracks a built-in automation when its enabled state changes', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'channel-1',
      channelName: 'reports',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        managerStatsFrequency: 'weekly',
        managerStatsDiscordChannel: 'channel-1',
      }),
    );

    expect(result.success).toBe(true);
    expect(mockCaptureActivationAutomationChanged).toHaveBeenCalledWith(
      'enabled',
      'manager_stats',
    );
  });

  it('does not track a built-in automation when its enabled state is unchanged', async () => {
    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({ savingAutomation: 'managerStats' }),
    );

    expect(result.success).toBe(true);
    expect(mockCaptureActivationAutomationChanged).not.toHaveBeenCalled();
  });

  it('persists provider usage frequency and threshold without creating task state', async () => {
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerSlackChannelId: 'C-MANAGER',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'providerUsageLimit',
        providerUsageLimitFrequency: 'daily',
        providerUsageLimitThreshold: 5,
        providerUsageLimitSlackChannel: null,
        providerUsageLimitDiscordChannel: null,
      }),
    );
    const automation = await db.query.automations.findFirst({
      where: eq(automations.key, 'provider_usage_limit'),
    });

    expect(result.success).toBe(true);
    expect(automation).toMatchObject({
      enabled: true,
      schedule: { mode: 'daily' },
      settings: { threshold: 5 },
      targets: [],
    });
  });

  it('persists a Discord provider usage alert destination', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'provider-alerts',
      channelName: 'provider-alerts',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'providerUsageLimit',
        providerUsageLimitFrequency: 'every_hour',
        providerUsageLimitThreshold: 85,
        providerUsageLimitDiscordChannel: 'provider-alerts',
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('provider_usage_limit')).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'provider-alerts',
      },
    ]);
  });

  it('rejects provider usage thresholds outside slider increments', async () => {
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerSlackChannelId: 'C-MANAGER',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'providerUsageLimit',
        providerUsageLimitFrequency: 'every_hour',
        providerUsageLimitThreshold: 81,
      }),
    );

    expect(result).toEqual({
      success: false,
      fieldErrors: {
        general:
          'Provider usage threshold must be between 5% and 95% in 5% increments.',
      },
    });
  });

  it('disables provider usage alerts without requiring a Slack channel', async () => {
    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'providerUsageLimit',
        providerUsageLimitFrequency: 'off',
        providerUsageLimitThreshold: 85,
      }),
    );
    const automation = await db.query.automations.findFirst({
      where: eq(automations.key, 'provider_usage_limit'),
    });

    expect(result.success).toBe(true);
    expect(automation).toMatchObject({ enabled: false, schedule: {} });
    expect(mockCaptureActivationAutomationChanged).toHaveBeenCalledWith(
      'disabled',
      'provider_usage_limit',
    );
  });

  it('tracks a built-in automation when it is disabled', async () => {
    await upsertAutomation(db, {
      key: 'manager_stats',
      enabled: true,
      schedule: { mode: 'weekly' },
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({ savingAutomation: 'managerStats' }),
    );

    expect(result.success).toBe(true);
    expect(mockCaptureActivationAutomationChanged).toHaveBeenCalledWith(
      'disabled',
      'manager_stats',
    );
  });

  it('preserves a disabled emoji trigger during an unrelated save', async () => {
    await upsertAutomation(db, {
      key: 'call_roomote_via_emoji',
      enabled: false,
      instructions: 'Prioritize safety.',
      settings: { emoji: ':white_check_mark:' },
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({ savingAutomation: 'managerStats' }),
    );
    const automation = await db.query.automations.findFirst({
      where: eq(automations.key, 'call_roomote_via_emoji'),
    });

    expect(result.success).toBe(true);
    expect(automation).toMatchObject({
      enabled: false,
      instructions: 'Prioritize safety.',
      settings: { emoji: ':white_check_mark:' },
    });
  });

  it('saves a Discord manager channel without Slack and returns the persisted id', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'managers',
    });
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerSlackChannelId: 'C123OLD',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerChannel',
        managerDiscordChannel: 'D111',
      }),
    );

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.settings.managerDiscordChannelId).toBe('D111');
      expect(result.settings.managerSlackChannelId).toBeNull();
      expect(result.settings.suggesterFrequency).toBe('off');
      expect(result.settings.announcerFrequency).toBe('off');
      expect(result.settings.managerStatsFrequency).toBe('off');
    }
  }, 15_000);

  it('switches a Discord manager channel to Slack and clears Discord', async () => {
    await insertSlackInstallation();
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerDiscordChannelId: 'D111',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerChannel',
        managerSlackChannel: 'C123456NEW',
      }),
    );

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.settings.managerSlackChannelId).toBe('C123456NEW');
      expect(result.settings.managerDiscordChannelId).toBeNull();
      expect(result.settings.suggesterFrequency).toBe('daily');
      expect(result.settings.announcerFrequency).toBe('weekly');
      expect(result.settings.managerStatsFrequency).toBe('weekly');
    }
    expect(mockCaptureActivationAutomationChanged.mock.calls).toEqual(
      expect.arrayContaining([
        ['enabled', 'suggester'],
        ['enabled', 'announcer'],
        ['enabled', 'manager_stats'],
      ]),
    );
  }, 15_000);

  it('preserves a Discord manager channel when a legacy manager save omits the Discord field', async () => {
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerDiscordChannelId: 'D111',
    });
    const input = buildInput({
      savingAutomation: 'managerChannel',
      managerSlackChannel: null,
    });
    delete input.managerDiscordChannel;

    const result = await updateBackgroundAgentSettingsCommand(adminAuth, input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.settings.managerDiscordChannelId).toBe('D111');
      expect(result.settings.managerSlackChannelId).toBeNull();
    }
  }, 15_000);

  it('rejects a Discord manager channel outside the available catalog', async () => {
    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerChannel',
        managerDiscordChannel: 'D999',
      }),
    );

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.fieldErrors.managerDiscordChannel).toBe(
        'This Discord channel is not available to Roomote.',
      );
      expect(result.fieldErrors.general).toBeUndefined();
    }
  }, 15_000);

  it('preserves a Discord manager channel on unrelated saves and uses it as the automation destination', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'managers',
    });
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerDiscordChannelId: 'D111',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        managerStatsFrequency: 'weekly',
      }),
    );

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.settings.managerDiscordChannelId).toBe('D111');
      expect(result.settings.managerSlackChannelId).toBeNull();
      expect(result.settings.managerStatsFrequency).toBe('weekly');
    }
  }, 15_000);

  it('writes a discord_channel target and clears the Slack one without requiring a Slack installation', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });
    // The automation previously reported to a Slack channel.
    await upsertAutomation(db, {
      key: 'manager_stats',
      enabled: true,
      schedule: { mode: 'weekly' },
      targets: [
        {
          provider: 'slack',
          targetKind: 'slack_channel',
          externalRef: 'C123OLD',
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        managerStatsFrequency: 'weekly',
        managerStatsDiscordChannel: 'D111',
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('manager_stats')).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D111',
      },
    ]);

    if (result.success) {
      expect(result.settings.managerStatsDiscordChannelId).toBe('D111');
      expect(result.settings.managerStatsSlackChannelId).toBeNull();
    }
  }, 15_000);

  it('writes a slack_channel target and clears the Discord one when Slack is selected', async () => {
    await insertSlackInstallation();
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });
    await upsertAutomation(db, {
      key: 'manager_stats',
      enabled: true,
      schedule: { mode: 'weekly' },
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D111',
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        managerStatsFrequency: 'weekly',
        managerStatsSlackChannel: 'C123456NEW',
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('manager_stats')).toEqual([
      {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'C123456NEW',
      },
    ]);
  }, 15_000);

  it('rejects a Discord channel that is not in the available channel catalog', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'ciFailureTriage',
        ciFailureTriageFrequency: 'daily',
        ciFailureTriageDiscordChannel: 'D999',
      }),
    );

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.fieldErrors.ciFailureTriageDiscordChannel).toBe(
        'This Discord channel is not available to Roomote.',
      );
      expect(result.fieldErrors.general).toBeUndefined();
    }
  }, 15_000);

  it('preserves another automation Discord target when saving an unrelated automation', async () => {
    await insertSlackInstallation();
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });
    // A shared manager channel exists; it must not be materialized as an
    // own Slack target for an automation that reports to Discord.
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerSlackChannelId: 'C999MANAGER',
    });
    await upsertAutomation(db, {
      key: 'ci_failure_triage',
      enabled: true,
      schedule: { mode: 'daily' },
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D222',
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        managerStatsFrequency: 'weekly',
        managerStatsSlackChannel: 'C123456NEW',
        ciFailureTriageFrequency: 'daily',
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('ci_failure_triage')).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D222',
      },
    ]);
  }, 15_000);

  it('does not validate an enabled automation while saving an unrelated automation', async () => {
    await upsertAutomation(db, {
      key: 'dependabot_triage',
      enabled: true,
      schedule: { mode: 'daily' },
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        dependabotTriageFrequency: 'daily',
      }),
    );

    expect(result.success).toBe(true);
  });

  it('does not require Slack for an unrelated persisted destination', async () => {
    await upsertAutomation(db, {
      key: 'dependabot_triage',
      enabled: true,
      schedule: { mode: 'daily' },
      targets: [
        {
          provider: 'slack',
          targetKind: 'slack_channel',
          externalRef: 'C123ALERTS',
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        dependabotTriageFrequency: 'daily',
        dependabotTriageSlackChannel: '#alerts',
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('dependabot_triage')).toEqual([
      {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'C123ALERTS',
      },
    ]);
  });

  it('still validates an enabled automation when saving that automation', async () => {
    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'dependabotTriage',
        dependabotTriageFrequency: 'daily',
      }),
    );

    expect(result).toMatchObject({
      success: false,
      fieldErrors: {
        general: 'Connect GitHub before enabling Triage Dependabot Alerts.',
      },
    });
  });

  it('writes a suggester discord_channel target and clears its Slack one', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });
    await upsertAutomation(db, {
      key: 'suggester',
      enabled: true,
      schedule: { mode: 'daily' },
      targets: [
        {
          provider: 'slack',
          targetKind: 'slack_channel',
          externalRef: 'C123OLD',
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'suggester',
        suggesterFrequency: 'daily',
        suggesterDiscordChannel: 'D111',
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('suggester')).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D111',
      },
    ]);

    if (result.success) {
      expect(result.settings.suggesterDiscordChannelId).toBe('D111');
      expect(result.settings.suggesterSlackChannelId).toBeNull();
    }
  }, 15_000);

  it('writes an announcer slack_channel target and clears its Discord one', async () => {
    await insertSlackInstallation();
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });
    await upsertAutomation(db, {
      key: 'announcer',
      enabled: true,
      schedule: { mode: 'weekly' },
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D111',
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'announcer',
        announcerFrequency: 'weekly',
        announcerSlackChannel: 'C123456NEW',
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('announcer')).toEqual([
      {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'C123456NEW',
      },
    ]);

    if (result.success) {
      expect(result.settings.announcerSlackChannelId).toBe('C123456NEW');
      expect(result.settings.announcerDiscordChannelId).toBeNull();
    }
  }, 15_000);

  it('enables platform issue alerts with a Discord destination and prefers Discord over a submitted Slack channel', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'platformIssueAlerts',
        // Server-side one-of backstop: when both somehow arrive, Discord
        // wins and the Slack value is dropped.
        platformIssueSlackChannel: 'C123456NEW',
        platformIssueDiscordChannel: 'D111',
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('platform_issue_alerts')).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D111',
      },
    ]);

    const automation = await db.query.automations.findFirst({
      where: eq(automations.key, 'platform_issue_alerts'),
    });

    expect(automation?.enabled).toBe(true);

    if (result.success) {
      expect(result.settings.platformIssueDiscordChannelId).toBe('D111');
      expect(result.settings.platformIssueSlackChannelId).toBeNull();
    }
  }, 15_000);

  it('keeps platform issue alerts enabled by default without a channel', async () => {
    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'platformIssueAlerts',
        platformIssueSlackChannel: null,
        platformIssueDiscordChannel: null,
      }),
    );

    expect(result.success).toBe(true);
    const automation = await db.query.automations.findFirst({
      where: eq(automations.key, 'platform_issue_alerts'),
    });
    expect(automation).toMatchObject({
      enabled: true,
      settings: { optedOut: false },
      targets: [],
    });
    if (result.success) {
      expect(result.settings.platformIssueAlertsEnabled).toBe(true);
    }
  });

  it('keeps provider usage alerts on the Manager Channel fallback when it changes', async () => {
    await insertSlackInstallation();
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerSlackChannelId: 'C111MANAGER',
    });
    await upsertAutomation(db, {
      key: 'provider_usage_limit',
      enabled: true,
      schedule: { mode: 'every_hour' },
      settings: { threshold: 85 },
      targets: [],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerChannel',
        managerSlackChannel: 'C222MANAGER',
      }),
    );
    const settings = await db.query.deploymentSettings.findFirst();

    expect(result.success).toBe(true);
    expect(settings?.managerSlackChannelId).toBe('C222MANAGER');
    expect(await getAutomationTargets('provider_usage_limit')).toEqual([]);
  });

  it('persists an explicit platform issue alert opt-out', async () => {
    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'platformIssueAlerts',
        platformIssueAlertsEnabled: false,
      }),
    );

    expect(result.success).toBe(true);
    const automation = await db.query.automations.findFirst({
      where: eq(automations.key, 'platform_issue_alerts'),
    });
    expect(automation).toMatchObject({
      enabled: false,
      settings: { optedOut: true },
    });
    if (result.success) {
      expect(result.settings.platformIssueAlertsEnabled).toBe(false);
    }
  });

  it('preserves an explicit opt-out when an older client omits the enabled field', async () => {
    await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'platformIssueAlerts',
        platformIssueAlertsEnabled: false,
      }),
    );
    const legacyInput = buildInput({ savingAutomation: 'platformIssueAlerts' });
    delete (legacyInput as Partial<UpdateBackgroundAgentSettingsInput>)
      .platformIssueAlertsEnabled;

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      legacyInput,
    );

    expect(result.success).toBe(true);
    const automation = await db.query.automations.findFirst({
      where: eq(automations.key, 'platform_issue_alerts'),
    });
    expect(automation).toMatchObject({
      enabled: false,
      settings: { optedOut: true },
    });
  });

  it('preserves a Discord target when an older client omits the optional field on a same-automation save', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });

    // A new client selects a Discord destination for platform issue alerts.
    const first = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'platformIssueAlerts',
        platformIssueDiscordChannel: 'D111',
      }),
    );
    expect(first.success).toBe(true);

    // An older client (deployed before the field existed) re-saves the same
    // automation without ever sending platformIssueDiscordChannel. Omission
    // must preserve the target, not clear it and disable the automation.
    const input = buildInput({ savingAutomation: 'platformIssueAlerts' });
    delete (input as unknown as Record<string, unknown>)
      .platformIssueDiscordChannel;
    const second = await updateBackgroundAgentSettingsCommand(adminAuth, input);

    expect(second.success).toBe(true);
    expect(await getAutomationTargets('platform_issue_alerts')).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D111',
      },
    ]);
    const automation = await db.query.automations.findFirst({
      where: eq(automations.key, 'platform_issue_alerts'),
    });
    expect(automation?.enabled).toBe(true);
  }, 15_000);

  it('clears the Discord target when a legacy client explicitly selects a Slack channel', async () => {
    await insertSlackInstallation();
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });
    const first = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'platformIssueAlerts',
        platformIssueDiscordChannel: 'D111',
      }),
    );
    expect(first.success).toBe(true);

    // A pre-deploy client cannot send the Discord field, but choosing a
    // Slack channel is an explicit destination choice: it must clear the
    // Discord target rather than leaving both stored (a later current-client
    // save would otherwise silently flip routing back to Discord).
    const input = buildInput({
      savingAutomation: 'platformIssueAlerts',
      platformIssueSlackChannel: 'C123456NEW',
    });
    delete (input as unknown as Record<string, unknown>)
      .platformIssueDiscordChannel;
    const second = await updateBackgroundAgentSettingsCommand(adminAuth, input);

    expect(second.success).toBe(true);
    expect(await getAutomationTargets('platform_issue_alerts')).toEqual([
      {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'C123456NEW',
      },
    ]);
  }, 15_000);

  it('preserves suggester, announcer, and platform issue Discord targets when saving an unrelated automation', async () => {
    await insertSlackInstallation();
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'automation-reports',
    });

    for (const key of [
      'suggester',
      'announcer',
      'platform_issue_alerts',
    ] as const) {
      await upsertAutomation(db, {
        key,
        enabled: true,
        ...(key === 'platform_issue_alerts'
          ? {}
          : { schedule: { mode: 'daily' } }),
        targets: [
          {
            provider: 'discord',
            targetKind: 'discord_channel',
            externalRef: 'D111',
          },
        ],
      });
    }

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        managerStatsFrequency: 'weekly',
        managerStatsSlackChannel: 'C123456NEW',
        suggesterFrequency: 'daily',
        announcerFrequency: 'daily',
      }),
    );

    expect(result.success).toBe(true);

    for (const key of [
      'suggester',
      'announcer',
      'platform_issue_alerts',
    ] as const) {
      expect(await getAutomationTargets(key)).toEqual([
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D111',
        },
      ]);
    }
  }, 15_000);
});

async function getAutomationTargetsWithMetadata(key: BackgroundAutomationKey) {
  const automation = await db.query.automations.findFirst({
    where: eq(automations.key, key),
  });

  return automation?.targets ?? [];
}

describe('updateBackgroundAgentSettingsCommand Discord channel auto-start', () => {
  beforeEach(async () => {
    await db.delete(automations);
    await db.delete(deploymentSettings);
    await db.delete(discordInstallations);
    await db.delete(slackInstallations);
    await db.delete(users).where(eq(users.id, adminAuth.userId));
  });

  it('writes discord auto-respond targets alongside Slack ones with merged order', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'bugs',
    });
    await insertSlackInstallation();

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'channelAutoStart',
        channelAutoStartSlackChannels: [
          {
            channelId: 'C0BUGS1234',
            slackChannel: '#bugs',
            instructions: 'Slack bug triage.',
            launchMode: 'always_start',
            launchCriteria: null,
          },
        ],
        channelAutoStartDiscordChannels: [
          {
            channelId: 'D111',
            instructions: 'Discord bug triage.',
            launchMode: 'always_start',
            launchCriteria: 'Only real bugs.',
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect(
      await getAutomationTargetsWithMetadata('slack_channel_auto_start'),
    ).toEqual([
      {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'C0BUGS1234',
        metadata: { order: 0, instructions: 'Slack bug triage.' },
      },
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D111',
        metadata: {
          order: 1,
          instructions: 'Discord bug triage.',
          launchCriteria: 'Only real bugs.',
        },
      },
    ]);

    if (!result.success) throw new Error('unreachable');
    expect(result.settings.channelAutoStartDiscordChannels).toEqual([
      {
        channelId: 'D111',
        instructions: 'Discord bug triage.',
        launchMode: 'always_start',
        launchCriteria: 'Only real bugs.',
      },
    ]);
    expect(result.settings.channelAutoStartEnabled).toBe(true);
  }, 15_000);

  it('supports discord-only auto-respond without a Slack installation', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'bugs',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'channelAutoStart',
        channelAutoStartSlackChannels: [],
        channelAutoStartDiscordChannels: [
          {
            channelId: 'D111',
            instructions: null,
            launchMode: 'always_start',
            launchCriteria: null,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('slack_channel_auto_start')).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D111',
      },
    ]);
  }, 15_000);

  it('rejects a discord auto-respond channel missing from the catalog', async () => {
    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'channelAutoStart',
        channelAutoStartSlackChannels: [],
        channelAutoStartDiscordChannels: [
          {
            channelId: 'D404',
            instructions: null,
            launchMode: 'always_start',
            launchCriteria: null,
          },
        ],
      }),
    );

    expect(result).toEqual({
      success: false,
      fieldErrors: expect.objectContaining({
        channelAutoStartDiscordChannels:
          'This Discord channel is not available to Roomote.',
      }),
    });
  }, 15_000);

  it('rejects discord channel types that cannot anchor task threads', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D115',
      channelName: 'forum',
      channelType: 15,
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'channelAutoStart',
        channelAutoStartSlackChannels: [],
        channelAutoStartDiscordChannels: [
          {
            channelId: 'D115',
            instructions: null,
            launchMode: 'always_start',
            launchCriteria: null,
          },
        ],
      }),
    );

    expect(result).toEqual({
      success: false,
      fieldErrors: expect.objectContaining({
        channelAutoStartDiscordChannels:
          'Auto-respond supports Discord text and announcement channels only.',
      }),
    });
  }, 15_000);

  it('rejects duplicate discord auto-respond channels', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'bugs',
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'channelAutoStart',
        channelAutoStartSlackChannels: [],
        channelAutoStartDiscordChannels: [
          {
            channelId: 'D111',
            instructions: null,
            launchMode: 'always_start',
            launchCriteria: null,
          },
          {
            channelId: 'D111',
            instructions: 'Second copy.',
            launchMode: 'always_start',
            launchCriteria: null,
          },
        ],
      }),
    );

    expect(result).toEqual({
      success: false,
      fieldErrors: expect.objectContaining({
        channelAutoStartDiscordChannels:
          'Each auto-respond channel can only be configured once.',
      }),
    });
  }, 15_000);

  it('preserves persisted discord rows when an older client omits the field', async () => {
    await upsertAutomation(db, {
      key: 'slack_channel_auto_start',
      enabled: true,
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D111',
          metadata: { order: 0, instructions: 'Keep me.' },
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'channelAutoStart',
        channelAutoStartSlackChannels: [],
        // channelAutoStartDiscordChannels deliberately omitted (legacy client)
      }),
    );

    expect(result.success).toBe(true);
    expect(
      await getAutomationTargetsWithMetadata('slack_channel_auto_start'),
    ).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D111',
        metadata: { order: 0, instructions: 'Keep me.' },
      },
    ]);
  }, 15_000);

  it('clears discord rows when a new client explicitly submits an empty list', async () => {
    await upsertAutomation(db, {
      key: 'slack_channel_auto_start',
      enabled: true,
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D111',
          metadata: { order: 0 },
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'channelAutoStart',
        channelAutoStartSlackChannels: [],
        channelAutoStartDiscordChannels: [],
      }),
    );

    expect(result.success).toBe(true);
    expect(await getAutomationTargets('slack_channel_auto_start')).toEqual([]);
  }, 15_000);

  it('keeps discord auto-respond rows intact when saving an unrelated automation', async () => {
    await insertAvailableDiscordChannel({
      guildId: 'guild-1',
      channelId: 'D111',
      channelName: 'reports',
    });
    await upsertAutomation(db, {
      key: 'slack_channel_auto_start',
      enabled: true,
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D222',
          metadata: { order: 0, instructions: 'Keep me.' },
        },
      ],
    });

    const result = await updateBackgroundAgentSettingsCommand(
      adminAuth,
      buildInput({
        savingAutomation: 'managerStats',
        managerStatsFrequency: 'weekly',
        managerStatsDiscordChannel: 'D111',
      }),
    );

    expect(result.success).toBe(true);
    expect(
      await getAutomationTargetsWithMetadata('slack_channel_auto_start'),
    ).toEqual([
      {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: 'D222',
        metadata: { order: 0, instructions: 'Keep me.' },
      },
    ]);
  }, 15_000);
});

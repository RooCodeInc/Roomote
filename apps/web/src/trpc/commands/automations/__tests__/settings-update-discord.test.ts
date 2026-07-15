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
import type { FeatureFlag } from '@roomote/feature-flags';
import type { BackgroundAutomationKey } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { updateBackgroundAgentSettingsCommand } from '../settings-update';
import type { UpdateBackgroundAgentSettingsInput } from '../types';

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
  featureFlags: {} as Record<FeatureFlag, boolean>,
  anonymousAnalyticsEnabled: false,
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
    suggesterInstructions: null,
    suggesterRoutingMode: 'manager_channel',
    suggesterRoutingInstructions: null,
    announcerFrequency: 'off',
    announcerSlackChannel: null,
    announcerInstructions: null,
    platformIssueSlackChannel: null,
    ...overrides,
  };
}

async function insertAvailableDiscordChannel(params: {
  guildId: string;
  channelId: string;
  channelName: string;
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
    channelType: 0,
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
    await db.delete(automations);
    await db.delete(deploymentSettings);
    await db.delete(discordInstallations);
    await db.delete(slackInstallations);
    await db.delete(users);
  });

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
});

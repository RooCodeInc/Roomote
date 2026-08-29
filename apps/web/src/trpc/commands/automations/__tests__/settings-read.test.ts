import {
  automations,
  db,
  deploymentSettings,
  runFactory,
  slackInstallations,
  taskFactory,
  tasks,
  upsertAutomation,
  users,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { getBackgroundAgentSettingsCommand } from '../settings-read';

const SETTINGS_READ_USER_ID = 'user-settings-read-admin';
const MANAGER_CHANNEL_ID = 'CMANAGER1';
const MANAGER_DISCORD_CHANNEL_ID = 'DMANAGER1';
const STATS_CHANNEL_ID = 'CSTATS111';

const adminAuth: UserAuthSuccess = {
  success: true,
  userType: 'user',
  userId: SETTINGS_READ_USER_ID,
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

/**
 * Records how many Slack calls are in flight at once so the test can tell a
 * serialized fan-out from a concurrent one.
 */
function createSlackFetchRecorder() {
  const urls: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;

  const impl = async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);

    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        ok: true,
        channel: { name: 'reports', is_member: true, is_private: false },
      }),
    } as unknown as Response;
  };

  return {
    impl,
    urls,
    get peakInFlight() {
      return peakInFlight;
    },
    countFor: (channelId: string) =>
      urls.filter(
        (url) => url.includes('conversations.info') && url.includes(channelId),
      ).length,
  };
}

describe('getBackgroundAgentSettingsCommand Slack fan-out', () => {
  let recorder: ReturnType<typeof createSlackFetchRecorder>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.SLACK_API_BASE_URL = 'https://slack.com/api/';

    await db.delete(tasks);
    await db.delete(automations);
    await db.delete(deploymentSettings);
    await db.delete(slackInstallations);

    // Other suites share this database, so the fixture user is scoped to this
    // file instead of clearing the whole users table.
    await db
      .insert(users)
      .values({
        id: SETTINGS_READ_USER_ID,
        name: 'Admin',
        email: 'settings-read-admin@example.com',
        imageUrl: '',
        entity: {},
      })
      .onConflictDoNothing({ target: users.id });

    await db.insert(slackInstallations).values({
      teamId: 'T123',
      teamName: 'Acme',
      appId: 'A123',
      botUserId: 'B123',
      botAccessToken: 'xoxb-test',
      scopes: {
        bot: ['channels:read', 'groups:read', 'reactions:read', 'team:read'],
      },
      installedByUserId: SETTINGS_READ_USER_ID,
      isActive: true,
    });

    await db.insert(deploymentSettings).values({
      managerSlackChannelId: MANAGER_CHANNEL_ID,
      managerDiscordChannelId: MANAGER_DISCORD_CHANNEL_ID,
    });

    // Only the manager-stats automation reports to its own channel; every
    // other reporting automation falls back to the manager channel.
    await upsertAutomation(db, {
      key: 'manager_stats',
      enabled: true,
      schedule: { mode: 'weekly' },
      targets: [
        {
          provider: 'slack',
          targetKind: 'slack_channel',
          externalRef: STATS_CHANNEL_ID,
        },
      ],
    });

    recorder = createSlackFetchRecorder();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(recorder.impl as unknown as typeof fetch);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('runs the warning, display-name and destination rounds concurrently and resolves each channel once', async () => {
    const result = await getBackgroundAgentSettingsCommand(adminAuth);

    // The access-warning round only sees the stats channel and the
    // display-name round only adds the manager channel, so two simultaneous
    // conversations.info calls can only happen if the rounds overlap.
    expect(recorder.peakInFlight).toBeGreaterThanOrEqual(2);

    // The per-request memo collapses the repeated lookups of each channel.
    expect(recorder.countFor(STATS_CHANNEL_ID)).toBe(1);
    expect(recorder.countFor(MANAGER_CHANNEL_ID)).toBe(1);

    expect(result.slackChannelDisplayNames.managerSlackChannel).toBe(
      '#reports',
    );
    expect(result.slackChannelDisplayNames.managerStatsSlackChannel).toBe(
      '#reports',
    );
    // The bot is a member of both channels, so nothing is flagged.
    expect(
      result.slackChannelAccessWarnings.managerStatsSlackChannel,
    ).toBeNull();
    expect(result.resolvedDestinations.manager_stats?.channelId).toBe(
      STATS_CHANNEL_ID,
    );
    expect(result.settings.managerDiscordChannelId).toBe(
      MANAGER_DISCORD_CHANNEL_ID,
    );
    expect(result.capabilities.slackConnected).toBe(true);
    expect(result.automationStatus.manager_stats?.enabled).toBe(true);
  });

  it('links automation history to the exact triggering Slack message', async () => {
    await upsertAutomation(db, {
      key: 'ci_failure_triage',
      enabled: true,
      schedule: { mode: 'off' },
    });
    const task = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorUserId: null,
      actorExternalId: null,
      initiatorAutomation: 'ci_failure_triage',
      surface: 'slack',
      trigger: 'message',
      slackChannelId: 'CSOURCE1',
      slackThreadTs: '1788000000.000100',
      title: 'Investigate failing CI',
    });
    await runFactory.create({
      taskId: task.id,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'RooCodeInc/Roomote',
        description: 'Investigate failing CI',
        communicationProvider: 'slack',
        communicationTeamId: 'T123',
        communicationTeamDomain: 'acme',
        communicationChannelId: 'CSOURCE1',
        communicationThreadId: '1788000000.000100',
        communicationMessageId: '1788000001.000200',
      },
    });
    await runFactory.create({
      taskId: task.id,
      kind: 'resume',
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'RooCodeInc/Roomote',
        description: 'Resume CI investigation',
        communicationProvider: 'slack',
        communicationTeamDomain: 'wrong-workspace',
        communicationChannelId: 'CWRONG',
        communicationThreadId: '1788000002.000300',
        communicationMessageId: '1788000003.000400',
      },
    });

    const scheduledTask = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorUserId: null,
      actorExternalId: null,
      initiatorAutomation: 'ci_failure_triage',
      surface: 'system',
      trigger: 'schedule',
      slackChannelId: 'CREPORT1',
      slackThreadTs: '1788000004.000500',
      title: 'Scheduled CI scan',
    });
    await runFactory.create({
      taskId: scheduledTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'RooCodeInc/Roomote',
        description: 'Scheduled CI scan',
        communicationProvider: 'slack',
        communicationTeamDomain: 'acme',
        communicationChannelId: 'CREPORT1',
        communicationThreadId: '1788000004.000500',
      },
    });

    const result = await getBackgroundAgentSettingsCommand(adminAuth);

    expect(result.recentRuns.ci_failure_triage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: scheduledTask.id,
          sourceLabel: null,
          sourceUrl: null,
        }),
        expect.objectContaining({
          taskId: task.id,
          sourceLabel: 'Open source message',
          sourceUrl:
            'https://acme.slack.com/archives/CSOURCE1/p1788000001000200?thread_ts=1788000000.000100&cid=CSOURCE1',
        }),
      ]),
    );
  });
});

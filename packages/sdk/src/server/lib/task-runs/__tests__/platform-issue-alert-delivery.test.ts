const {
  mockCreateDiscordProvider,
  mockDiscordPostMessage,
  mockSlackPostMessage,
  mockCreateTeamsProvider,
  mockTeamsPostMessage,
} = vi.hoisted(() => ({
  mockCreateDiscordProvider: vi.fn(),
  mockDiscordPostMessage: vi.fn(),
  mockSlackPostMessage: vi.fn(),
  mockCreateTeamsProvider: vi.fn(),
  mockTeamsPostMessage: vi.fn(),
}));

vi.mock('../../discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    mockCreateDiscordProvider,
}));

vi.mock('../../teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials:
    mockCreateTeamsProvider,
}));

// Keep the test hermetic: the Slack fallback path constructs a SlackNotifier
// from the active installation and posts the alert through it.
vi.mock('@roomote/slack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/slack')>();

  class MockSlackNotifier {
    constructor(_token: string) {}

    postMessage(...args: unknown[]) {
      return mockSlackPostMessage(...args);
    }
  }

  return { ...actual, SlackNotifier: MockSlackNotifier };
});

import {
  db,
  deploymentSettings,
  eq,
  slackInstallations,
  teamsInstallations,
  taskFactory,
  taskPlatformIssueReports,
  taskRuns,
  upsertAutomation,
  users,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  TaskPayloadKind,
  type AcpPersistedEnvelope,
} from '@roomote/types';

import { recordTaskMessageEnvelope } from '../record-task-message-envelope';

const REPORT = {
  title: 'Broken webhook secret',
  summary: 'The GitHub webhook secret is rejected; deliveries are failing.',
};

let messageTs = 1_000;

function buildReportEnvelope(): AcpPersistedEnvelope {
  messageTs += 1;

  return {
    ts: messageTs,
    eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
    role: 'assistant',
    protocol: 'roomote_runtime',
    contentBlocks: [],
    metadata: null,
    payload: {
      isMcp: true,
      toolName: 'report_platform_issue',
      output: JSON.stringify({ success: true, report: REPORT }),
    },
  };
}

async function seedTaskRun(taskId: string): Promise<number> {
  await taskFactory.create({
    id: taskId,
    modelProvider: 'roomote',
    model: 'test-model',
    title: 'Platform issue task',
    workflow: 'pr_review',
    surface: 'github',
    trigger: 'webhook',
  });

  const [run] = await db
    .insert(taskRuns)
    .values({
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      payload: { repo: 'owner/repo' },
      taskId,
    })
    .returning({ id: taskRuns.id });

  if (!run) {
    throw new Error('Failed to seed task run');
  }

  return run.id;
}

async function findReportRow(taskId: string) {
  return db.query.taskPlatformIssueReports.findFirst({
    where: eq(taskPlatformIssueReports.taskId, taskId),
    columns: { report: true, slackPostedAt: true },
  });
}

describe('platform issue alert delivery', () => {
  beforeEach(async () => {
    process.env.R_APP_URL = 'https://app.example.com';
    mockCreateDiscordProvider.mockReset();
    mockDiscordPostMessage.mockReset();
    mockSlackPostMessage.mockReset();
    mockCreateTeamsProvider.mockReset();
    mockTeamsPostMessage.mockReset();
    mockCreateDiscordProvider.mockResolvedValue({
      postMessage: mockDiscordPostMessage,
    });
    mockDiscordPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'D111',
      messageId: 'm1',
    });
    mockSlackPostMessage.mockResolvedValue('1727000000.000100');
    mockCreateTeamsProvider.mockResolvedValue({
      postMessage: mockTeamsPostMessage,
    });

    await db.delete(taskPlatformIssueReports);
    await db.delete(deploymentSettings);
    await db.delete(slackInstallations);
    await db.delete(teamsInstallations);
  });

  it('posts the alert to the automation Discord channel when its own destination is Discord', async () => {
    const taskId = 'task-platform-issue-discord';
    const runId = await seedTaskRun(taskId);

    await upsertAutomation(db, {
      key: 'platform_issue_alerts',
      enabled: true,
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D111',
        },
      ],
    });

    await recordTaskMessageEnvelope({
      runId,
      taskId,
      envelope: buildReportEnvelope(),
    });

    expect(mockDiscordPostMessage).toHaveBeenCalledTimes(1);
    const [post] = mockDiscordPostMessage.mock.calls[0] ?? [];
    expect(post).toMatchObject({
      channelId: 'D111',
      textFormat: 'markdown',
    });
    expect(post.text).toContain(`**${REPORT.title}**`);
    expect(post.text).toContain(REPORT.summary);
    expect(post.text).toContain(
      `[View task](https://app.example.com/task/${taskId}`,
    );
    expect(post.text).toContain('utm_source=discord');

    // No Slack post: the Discord destination owns the alert.
    expect(mockSlackPostMessage).not.toHaveBeenCalled();

    const reportRow = await findReportRow(taskId);
    expect(reportRow?.report).toEqual(REPORT);
    expect(reportRow?.slackPostedAt).not.toBeNull();
  });

  it('keeps the Slack manager-channel fallback when no Discord destination is configured', async () => {
    const taskId = 'task-platform-issue-slack';
    const runId = await seedTaskRun(taskId);

    await upsertAutomation(db, {
      key: 'platform_issue_alerts',
      enabled: false,
      targets: [],
    });
    await db.insert(deploymentSettings).values({
      id: 'default',
      managerSlackChannelId: 'C999MANAGER',
    });
    await db
      .insert(users)
      .values({
        id: 'user-admin',
        name: 'Admin',
        email: 'admin@example.com',
        imageUrl: '',
        entity: {},
      })
      .onConflictDoNothing();
    await db.insert(slackInstallations).values({
      teamId: 'T123',
      teamName: 'Acme',
      appId: 'A123',
      botUserId: 'B123',
      botAccessToken: 'xoxb-test',
      scopes: { bot: ['chat:write'] },
      installedByUserId: 'user-admin',
      isActive: true,
    });

    await recordTaskMessageEnvelope({
      runId,
      taskId,
      envelope: buildReportEnvelope(),
    });

    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
    expect(mockSlackPostMessage).toHaveBeenCalledTimes(1);
    const [post] = mockSlackPostMessage.mock.calls[0] ?? [];
    expect(post).toMatchObject({ channel: 'C999MANAGER' });
    expect(post.text).toContain(`*${REPORT.title}*`);
    expect(post.text).toContain('utm_source=slack');

    const reportRow = await findReportRow(taskId);
    expect(reportRow?.slackPostedAt).not.toBeNull();
  });

  it('leaves the report unposted when the Discord destination has no runtime credentials', async () => {
    const taskId = 'task-platform-issue-no-creds';
    const runId = await seedTaskRun(taskId);

    await upsertAutomation(db, {
      key: 'platform_issue_alerts',
      enabled: true,
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D111',
        },
      ],
    });
    mockCreateDiscordProvider.mockResolvedValue(null);

    await recordTaskMessageEnvelope({
      runId,
      taskId,
      envelope: buildReportEnvelope(),
    });

    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
    expect(mockSlackPostMessage).not.toHaveBeenCalled();

    const reportRow = await findReportRow(taskId);
    expect(reportRow?.report).toEqual(REPORT);
    expect(reportRow?.slackPostedAt).toBeNull();
  });

  it('posts to the explicitly selected Teams conversation with its stored service URL', async () => {
    const taskId = 'task-platform-issue-teams';
    const runId = await seedTaskRun(taskId);

    await upsertAutomation(db, {
      key: 'platform_issue_alerts',
      enabled: true,
      targets: [
        {
          provider: 'teams',
          targetKind: 'teams_channel',
          externalRef: 'teams-conversation',
        },
      ],
    });
    await db.insert(teamsInstallations).values({
      installationKey: 'team:teams-conversation',
      tenantId: 'tenant-1',
      conversationId: 'teams-conversation',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      botAppId: 'bot-app-1',
      isActive: true,
    });

    await recordTaskMessageEnvelope({
      runId,
      taskId,
      envelope: buildReportEnvelope(),
    });

    expect(mockTeamsPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'teams-conversation',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        textFormat: 'markdown',
      }),
    );
    expect(mockSlackPostMessage).not.toHaveBeenCalled();
    const [post] = mockTeamsPostMessage.mock.calls[0] ?? [];
    expect(post.text).toContain('utm_source=teams');
  });

  it('does not fall back to an unselected Teams conversation', async () => {
    const taskId = 'task-platform-issue-no-destination';
    const runId = await seedTaskRun(taskId);

    await upsertAutomation(db, {
      key: 'platform_issue_alerts',
      enabled: false,
      targets: [],
    });
    await db.insert(teamsInstallations).values({
      installationKey: 'team:unselected-conversation',
      tenantId: 'tenant-1',
      conversationId: 'unselected-conversation',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      botAppId: 'bot-app-1',
      isActive: true,
    });

    await recordTaskMessageEnvelope({
      runId,
      taskId,
      envelope: buildReportEnvelope(),
    });

    expect(mockTeamsPostMessage).not.toHaveBeenCalled();
  });
});

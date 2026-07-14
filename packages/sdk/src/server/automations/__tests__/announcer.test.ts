const {
  slackInstallationsTable,
  taskPullRequestsTable,
  mockSlackInstallationRows,
  mockMergedPullRequestRows,
  mockGetAutomationRuntime,
  mockRecordAutomationRunOutcome,
  mockUpsertBackgroundAutomationSlackThread,
  mockResolveAutomationRuntimeDestination,
  mockListConnectedCommunicationProviders,
  mockHasAnyActiveRepository,
  mockGetCommunicationProviderAdapter,
  mockLoadAutomationThreadFeedbackContext,
  mockGenerateTrackedNonTaskText,
  mockSlackNotifier,
  mockAdapterPostMessage,
} = vi.hoisted(() => ({
  slackInstallationsTable: {
    botAccessToken: 'botAccessToken',
    teamId: 'teamId',
    isActive: 'isActive',
  },
  taskPullRequestsTable: {
    repository: 'repository',
    prNumber: 'prNumber',
    prTitle: 'prTitle',
    prUrl: 'prUrl',
    detectedAt: 'detectedAt',
    status: 'status',
    taskId: 'taskId',
  },
  mockSlackInstallationRows: vi.fn(),
  mockMergedPullRequestRows: vi.fn(),
  mockGetAutomationRuntime: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
  mockUpsertBackgroundAutomationSlackThread: vi.fn(),
  mockResolveAutomationRuntimeDestination: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockHasAnyActiveRepository: vi.fn(),
  mockGetCommunicationProviderAdapter: vi.fn(),
  mockLoadAutomationThreadFeedbackContext: vi.fn(),
  mockGenerateTrackedNonTaskText: vi.fn(),
  mockSlackNotifier: vi.fn(),
  mockAdapterPostMessage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === slackInstallationsTable) {
          return { where: () => mockSlackInstallationRows() };
        }

        return {
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => mockMergedPullRequestRows(),
              }),
            }),
          }),
        };
      },
    })),
  },
  getAutomationRuntime: mockGetAutomationRuntime,
  recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
  upsertBackgroundAutomationSlackThread:
    mockUpsertBackgroundAutomationSlackThread,
  slackInstallations: slackInstallationsTable,
  taskPullRequests: taskPullRequestsTable,
  tasks: { id: 'id' },
  and: vi.fn(),
  eq: vi.fn(),
  gte: vi.fn(),
  isNotNull: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildManagerAutomationRootSummaryPromptContract: vi.fn(() => 'contract'),
}));

vi.mock('@roomote/cloud-agents/server/non-task-provider-usage', () => ({
  generateTrackedNonTaskText: mockGenerateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES: { backgroundAnnouncer: 'background_announcer' },
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: mockSlackNotifier,
}));

vi.mock('../automation-thread-feedback', () => ({
  loadAutomationThreadFeedbackContext: mockLoadAutomationThreadFeedbackContext,
}));

vi.mock('../destination', () => ({
  resolveAutomationRuntimeDestination: mockResolveAutomationRuntimeDestination,
  listConnectedCommunicationProviders: mockListConnectedCommunicationProviders,
}));

vi.mock('../github-deployment-scope', () => ({
  hasAnyActiveRepository: mockHasAnyActiveRepository,
}));

vi.mock('../../lib/communication-providers', () => ({
  getCommunicationProviderAdapter: mockGetCommunicationProviderAdapter,
}));

vi.mock('../../lib/manager-slack', () => ({
  buildAutomationRootSummaryMessage: vi.fn(),
  buildManagerSlackSettingsUrl: vi.fn(
    (hash: string) => `https://app.example.com/automations#${hash}`,
  ),
  degradeSlackMrkdwnToMarkdown: vi.fn((text: string) => `md(${text})`),
}));

vi.mock('../scheduling-utils', () => ({
  isRunDue: vi.fn(() => true),
  resolveSlackWorkspaceTimezone: vi.fn(async () => 'UTC'),
}));

import { SUMMARIZE_MERGED_PRS_SETTINGS_HASH } from '@roomote/types';

import { announcerJob } from '../announcer';

const SUMMARY = 'Shipped *two fixes* today.';
const SETTINGS_URL = `https://app.example.com/automations#${SUMMARIZE_MERGED_PRS_SETTINGS_HASH}`;

const MERGED_PR_ROWS = [
  {
    repo: 'acme/app',
    prNumber: 1,
    prTitle: 'Fix bug',
    prUrl: 'https://github.com/acme/app/pull/1',
    mergedAt: new Date('2026-07-12T00:00:00Z'),
  },
  {
    repo: 'acme/app',
    prNumber: 2,
    prTitle: 'Add thing',
    prUrl: 'https://github.com/acme/app/pull/2',
    mergedAt: new Date('2026-07-12T01:00:00Z'),
  },
];

const EXPECTED_DETAIL_MESSAGE = [
  '*acme/app*',
  '- Fix bug <https://github.com/acme/app/pull/1|#1>',
  '- Add thing <https://github.com/acme/app/pull/2|#2>',
].join('\n');

describe('announcerJob non-Slack posting', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockHasAnyActiveRepository.mockResolvedValue(true);
    mockSlackInstallationRows.mockResolvedValue([]);
    mockListConnectedCommunicationProviders.mockResolvedValue(['telegram']);
    mockGetAutomationRuntime.mockResolvedValue({
      key: 'announcer',
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      instructions: null,
      destination: null,
    });
    mockMergedPullRequestRows.mockResolvedValue(MERGED_PR_ROWS);
    mockLoadAutomationThreadFeedbackContext.mockResolvedValue(null);
    mockGenerateTrackedNonTaskText.mockResolvedValue(SUMMARY);

    let nextMessageId = 100;
    mockAdapterPostMessage.mockImplementation(
      async (input: { channelId: string }) => ({
        provider: 'telegram',
        channelId: input.channelId,
        messageId: `msg-${nextMessageId++}`,
      }),
    );
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      provider: 'telegram',
      postMessage: mockAdapterPostMessage,
    });
  });

  it('posts the report through the telegram adapter with markdown and a settings button', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });

    const result = await announcerJob({ manualTrigger: true });

    expect(result.completed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(mockSlackNotifier).not.toHaveBeenCalled();
    expect(mockGetCommunicationProviderAdapter).toHaveBeenCalledWith(
      'telegram',
    );

    // Root message: degraded markdown summary plus the settings link button.
    expect(mockAdapterPostMessage).toHaveBeenNthCalledWith(1, {
      channelId: '-100555',
      text: `md(${SUMMARY})`,
      textFormat: 'markdown',
      buttons: [[{ text: 'Automation settings', url: SETTINGS_URL }]],
    });

    // Tracked automation thread lands on the destination surface.
    expect(mockUpsertBackgroundAutomationSlackThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surface: 'telegram',
        automationKey: 'announcer',
        slackChannelId: '-100555',
        threadTs: 'msg-100',
        summaryText: SUMMARY,
      }),
    );

    // Detail messages thread under the root message id.
    expect(mockAdapterPostMessage).toHaveBeenNthCalledWith(2, {
      channelId: '-100555',
      threadId: 'msg-100',
      text: `md(${EXPECTED_DETAIL_MESSAGE})`,
      textFormat: 'markdown',
    });

    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'announcer', status: 'succeeded' }),
    );
  });

  it('threads teams detail messages with serviceUrl and replyToMessageId', async () => {
    mockListConnectedCommunicationProviders.mockResolvedValue(['teams']);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'teams',
      channelId: '19:conv@thread.v2',
      serviceUrl: 'https://smba.example/amer/',
    });
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      provider: 'teams',
      postMessage: mockAdapterPostMessage,
    });

    const result = await announcerJob({ manualTrigger: true });

    expect(result.completed).toBe(true);
    expect(mockAdapterPostMessage).toHaveBeenNthCalledWith(1, {
      channelId: '19:conv@thread.v2',
      serviceUrl: 'https://smba.example/amer/',
      text: `md(${SUMMARY})`,
      textFormat: 'markdown',
      buttons: [[{ text: 'Automation settings', url: SETTINGS_URL }]],
    });
    expect(mockAdapterPostMessage).toHaveBeenNthCalledWith(2, {
      channelId: '19:conv@thread.v2',
      serviceUrl: 'https://smba.example/amer/',
      threadId: 'msg-100',
      replyToMessageId: 'msg-100',
      text: `md(${EXPECTED_DETAIL_MESSAGE})`,
      textFormat: 'markdown',
    });
  });

  it('looks up thread feedback on the destination surface', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });

    await announcerJob({ manualTrigger: true });

    expect(mockLoadAutomationThreadFeedbackContext).toHaveBeenCalledWith(
      expect.objectContaining({
        automationKey: 'announcer',
        slackChannelId: '-100555',
        surface: 'telegram',
      }),
    );
  });

  it('records a failed outcome when the destination provider is not connected', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });
    mockGetCommunicationProviderAdapter.mockResolvedValue(null);

    const result = await announcerJob({ manualTrigger: true });

    expect(result.completed).toBe(false);
    expect(result.errors).toEqual([
      'Failed to post announcer summary: telegram is not connected',
    ]);
    expect(mockUpsertBackgroundAutomationSlackThread).not.toHaveBeenCalled();
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'announcer', status: 'failed' }),
    );
  });

  it('skips the deployment when no destination resolves', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue(null);

    const result = await announcerJob({ manualTrigger: true });

    expect(result.completed).toBe(false);
    expect(result.skippedReason).toBe('Announcer channel is not configured.');
    expect(mockAdapterPostMessage).not.toHaveBeenCalled();
  });
});

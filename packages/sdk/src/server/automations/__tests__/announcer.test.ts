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
  mockEnqueueTask,
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
  mockEnqueueTask: vi.fn(),
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
  enqueueTask: mockEnqueueTask,
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
  buildDestinationTaskPayloadFields: (destination: {
    provider: string;
    channelId: string;
    serviceUrl?: string;
  }) =>
    destination.provider === 'slack'
      ? {}
      : {
          communicationProvider: destination.provider,
          communicationChannelId: destination.channelId,
          ...(destination.serviceUrl
            ? { communicationServiceUrl: destination.serviceUrl }
            : {}),
        },
  buildDestinationPromptContext: (destination: { provider: string }) => ({
    channelTag:
      destination.provider === 'slack' ? 'slack_channel_id' : 'channel_id',
    postToolName:
      destination.provider === 'slack'
        ? 'post_to_slack_channel'
        : 'post_to_channel',
    surfaceLabel: destination.provider,
  }),
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
  '**acme/app**',
  '- Fix bug [#1](https://github.com/acme/app/pull/1)',
  '- Add thing [#2](https://github.com/acme/app/pull/2)',
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
    mockEnqueueTask.mockResolvedValue({ taskId: 'announcer-task-1' });

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

  it('launches a visible task for the telegram report', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });

    const result = await announcerJob({ manualTrigger: true });

    expect(result.completed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: '__all_repositories__',
            backgroundAutomationKey: 'announcer',
            communicationProvider: 'telegram',
            communicationChannelId: '-100555',
            description: expect.stringContaining(EXPECTED_DETAIL_MESSAGE),
          }),
        }),
        initiator: { kind: 'automation', key: 'announcer' },
        trigger: 'manual',
      }),
    );

    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'announcer', status: 'succeeded' }),
    );
  });

  it('stamps the Teams destination onto the task', async () => {
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
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationProvider: 'teams',
            communicationChannelId: '19:conv@thread.v2',
            communicationServiceUrl: 'https://smba.example/amer/',
          }),
        }),
      }),
    );
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

  it('records a failed outcome when task launch fails', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });
    mockEnqueueTask.mockRejectedValue(new Error('queue unavailable'));

    const result = await announcerJob({ manualTrigger: true });

    expect(result.completed).toBe(false);
    expect(result.errors).toEqual(['queue unavailable']);
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

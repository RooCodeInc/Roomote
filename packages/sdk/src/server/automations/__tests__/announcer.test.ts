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
  mockSlackNotifier,
  mockAdapterPostMessage,
  mockExecuteFastBuiltInAutomation,
  mockCompleteFastBuiltInAutomationNoop,
  mockRecordFastPreflightFailure,
  mockBuildScheduledAutomationOccurrenceKey,
  mockIsRunDue,
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
  mockSlackNotifier: vi.fn(),
  mockAdapterPostMessage: vi.fn(),
  mockExecuteFastBuiltInAutomation: vi.fn(),
  mockCompleteFastBuiltInAutomationNoop: vi.fn(),
  mockRecordFastPreflightFailure: vi.fn(),
  mockBuildScheduledAutomationOccurrenceKey: vi.fn(
    ({ partition }: { partition?: string }) =>
      `scheduled-slot:${partition ?? 'none'}`,
  ),
  mockIsRunDue: vi.fn((_input: { lastRunAt: Date | null }) => true),
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
    postToolName: 'post_to_channel',
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
  isRunDue: mockIsRunDue,
  resolveSlackWorkspaceTimezone: vi.fn(async () => 'UTC'),
}));

vi.mock('../custom-automation-schedule', () => ({
  resolveDeploymentTimeZone: vi.fn(async () => ({
    timeZone: 'UTC',
    source: 'utc_fallback',
    updatedAt: null,
  })),
}));

vi.mock('../fast-automation-runner', () => ({
  buildScheduledAutomationOccurrenceKey:
    mockBuildScheduledAutomationOccurrenceKey,
  executeFastBuiltInAutomation: mockExecuteFastBuiltInAutomation,
  completeFastBuiltInAutomationNoop: mockCompleteFastBuiltInAutomationNoop,
  recordFastBuiltInAutomationPreflightFailure: mockRecordFastPreflightFailure,
}));

import { announcerJob } from '../announcer';

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
    mockIsRunDue.mockReturnValue(true);
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
    mockExecuteFastBuiltInAutomation.mockResolvedValue({
      acquired: true,
      status: 'succeeded',
      automationRunId: 'run-1',
    });

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

  it('routes the pilot through Fast without launching a sandbox', async () => {
    mockGetAutomationRuntime.mockResolvedValue({
      key: 'announcer',
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      instructions: null,
      destination: null,
      executionRoute: 'fast',
    });
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });

    const result = await announcerJob({ manualTrigger: true });

    expect(result.completed).toBe(true);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockExecuteFastBuiltInAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        automationKey: 'announcer',
        triggerKind: 'manual',
        destination: { provider: 'telegram', channelId: '-100555' },
        prompt: expect.stringContaining('logicalMessageKey `summary`'),
      }),
    );
  });

  it('partitions scheduled Fast runs by active Slack installation', async () => {
    mockSlackInstallationRows.mockResolvedValue([
      { slackBotToken: 'xoxb-one', slackTeamId: 'T-ONE' },
      { slackBotToken: 'xoxb-two', slackTeamId: 'T-TWO' },
    ]);
    mockGetAutomationRuntime.mockResolvedValue({
      key: 'announcer',
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      instructions: null,
      destination: null,
      executionRoute: 'fast',
    });
    mockResolveAutomationRuntimeDestination
      .mockResolvedValueOnce({ provider: 'slack', channelId: 'C-ONE' })
      .mockResolvedValueOnce({ provider: 'slack', channelId: 'C-TWO' });

    const result = await announcerJob();

    expect(result.completed).toBe(true);
    expect(mockExecuteFastBuiltInAutomation).toHaveBeenCalledTimes(2);
    expect(
      mockExecuteFastBuiltInAutomation.mock.calls.map(
        ([input]) => input.occurrenceKey,
      ),
    ).toEqual([
      'scheduled-slot:slack:T-ONE:C-ONE',
      'scheduled-slot:slack:T-TWO:C-TWO',
    ]);
  });

  it('keeps every active Slack installation due for the scheduler pass', async () => {
    const firstRunAt = new Date('2026-07-12T02:00:00Z');
    mockSlackInstallationRows.mockResolvedValue([
      { slackBotToken: 'xoxb-one', slackTeamId: 'T-ONE' },
      { slackBotToken: 'xoxb-two', slackTeamId: 'T-TWO' },
    ]);
    mockGetAutomationRuntime
      .mockResolvedValueOnce({
        key: 'announcer',
        enabled: true,
        scheduleMode: 'daily',
        lastRunAt: null,
        instructions: null,
        destination: null,
        executionRoute: 'fast',
      })
      .mockResolvedValueOnce({
        key: 'announcer',
        enabled: true,
        scheduleMode: 'daily',
        lastRunAt: firstRunAt,
        instructions: null,
        destination: null,
        executionRoute: 'fast',
      });
    mockResolveAutomationRuntimeDestination
      .mockResolvedValueOnce({ provider: 'slack', channelId: 'C-ONE' })
      .mockResolvedValueOnce({ provider: 'slack', channelId: 'C-TWO' });
    mockIsRunDue.mockImplementation(
      ({ lastRunAt }: { lastRunAt: Date | null }) => lastRunAt === null,
    );

    await announcerJob();

    expect(mockGetAutomationRuntime).toHaveBeenCalledTimes(2);
    expect(mockIsRunDue).toHaveBeenCalledTimes(2);
    expect(mockIsRunDue.mock.calls.map(([input]) => input.lastRunAt)).toEqual([
      null,
      null,
    ]);
    expect(mockExecuteFastBuiltInAutomation).toHaveBeenCalledTimes(2);
    expect(
      mockExecuteFastBuiltInAutomation.mock.calls.map(
        ([input]) => input.occurrenceKey,
      ),
    ).toEqual([
      'scheduled-slot:slack:T-ONE:C-ONE',
      'scheduled-slot:slack:T-TWO:C-TWO',
    ]);
  });

  it('records deterministic Fast preflight failures durably', async () => {
    mockGetAutomationRuntime.mockResolvedValue({
      key: 'announcer',
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      instructions: null,
      destination: null,
      executionRoute: 'fast',
    });
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });
    mockMergedPullRequestRows.mockRejectedValue(new Error('collector failed'));

    const result = await announcerJob({ manualTrigger: true });

    expect(result.errors).toEqual(['collector failed']);
    expect(mockRecordFastPreflightFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        automationKey: 'announcer',
        error: 'collector failed',
      }),
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

const {
  slackInstallationsTable,
  pullRequestFactsTable,
  taskPullRequestsTable,
  repositoriesTable,
  mockSlackInstallationRows,
  mockMergedPullRequestRows,
  mockActiveRepositoryRows,
  mockGetAutomationRuntime,
  mockRecordAutomationRunOutcome,
  mockUpsertBackgroundAutomationSlackThread,
  mockResolveAutomationRuntimeDestination,
  mockResolveAutomationRepositoryDestination,
  mockListConnectedCommunicationProviders,
  mockHasAnyActiveRepository,
  mockGetCommunicationProviderAdapter,
  mockLoadAutomationThreadFeedbackContext,
  mockEnqueueTask,
  mockSlackNotifier,
  mockAdapterPostMessage,
  mockGte,
  mockSql,
} = vi.hoisted(() => ({
  slackInstallationsTable: {
    botAccessToken: 'botAccessToken',
    teamId: 'teamId',
    isActive: 'isActive',
  },
  pullRequestFactsTable: {
    repositoryId: 'factRepositoryId',
    prNumber: 'factPrNumber',
    mergedAtRemote: 'mergedAtRemote',
    body: 'body',
  },
  taskPullRequestsTable: {
    repository: 'repository',
    repositoryId: 'repositoryId',
    sourceControlProvider: 'sourceControlProvider',
    host: 'host',
    prNumber: 'prNumber',
    prTitle: 'prTitle',
    prUrl: 'prUrl',
    detectedAt: 'detectedAt',
    updatedAt: 'updatedAt',
    status: 'status',
    taskId: 'taskId',
  },
  repositoriesTable: {
    id: 'repositoryId',
    fullName: 'repositoryFullName',
    sourceControlProvider: 'sourceControlProvider',
    host: 'repositoryHost',
    isActive: 'isActive',
  },
  mockSlackInstallationRows: vi.fn(),
  mockMergedPullRequestRows: vi.fn(),
  mockActiveRepositoryRows: vi.fn(),
  mockGetAutomationRuntime: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
  mockUpsertBackgroundAutomationSlackThread: vi.fn(),
  mockResolveAutomationRuntimeDestination: vi.fn(),
  mockResolveAutomationRepositoryDestination: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockHasAnyActiveRepository: vi.fn(),
  mockGetCommunicationProviderAdapter: vi.fn(),
  mockLoadAutomationThreadFeedbackContext: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockSlackNotifier: vi.fn(),
  mockAdapterPostMessage: vi.fn(),
  mockGte: vi.fn(),
  mockSql: vi.fn(() => ({
    mapWith: () => ({ expression: 'mergedAt' }),
  })),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === slackInstallationsTable) {
          return { where: () => mockSlackInstallationRows() };
        }
        if (table === repositoriesTable) {
          return { where: () => mockActiveRepositoryRows() };
        }

        return {
          leftJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: () => mockMergedPullRequestRows(),
                }),
              }),
            }),
          }),
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
  pullRequestFacts: pullRequestFactsTable,
  taskPullRequests: taskPullRequestsTable,
  repositories: repositoriesTable,
  tasks: { id: 'id' },
  and: vi.fn(),
  eq: vi.fn(),
  gte: mockGte,
  isNotNull: vi.fn(),
  inArray: vi.fn(),
  or: vi.fn(),
  sql: mockSql,
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
    teamId?: string;
  }) =>
    destination.provider === 'slack'
      ? destination.teamId
        ? { teamId: destination.teamId }
        : {}
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

vi.mock('../ci-failure-triage-routing', () => ({
  resolveAutomationRepositoryDestination:
    mockResolveAutomationRepositoryDestination,
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

vi.mock('../custom-automation-schedule', () => ({
  resolveDeploymentTimeZone: vi.fn(async () => ({
    timeZone: 'UTC',
    source: 'utc_fallback',
    updatedAt: null,
  })),
}));

import { announcerJob, getRoomotePullRequestAttribution } from '../announcer';

const MERGED_PR_ROWS = [
  {
    repo: 'acme/app',
    repositoryId: '11111111-1111-4111-8111-111111111111',
    sourceControlProvider: 'github',
    host: null,
    prNumber: 1,
    prTitle: 'Fix bug',
    prUrl: 'https://github.com/acme/app/pull/1',
    mergedAt: new Date('2026-07-12T00:00:00Z'),
    attributionBody: null,
  },
  {
    repo: 'acme/app',
    repositoryId: '11111111-1111-4111-8111-111111111111',
    sourceControlProvider: 'github',
    host: null,
    prNumber: 2,
    prTitle: 'Add thing',
    prUrl: 'https://github.com/acme/app/pull/2',
    mergedAt: new Date('2026-07-12T01:00:00Z'),
    attributionBody: null,
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
      settings: {},
    });
    mockMergedPullRequestRows.mockResolvedValue(MERGED_PR_ROWS);
    mockActiveRepositoryRows.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        fullName: 'acme/app',
        sourceControlProvider: 'github',
        host: null,
      },
    ]);
    mockResolveAutomationRepositoryDestination.mockImplementation(
      async ({ destination }) => destination ?? null,
    );
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

  it('uses the remote merge timestamp for the report window', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });

    await announcerJob({ manualTrigger: true });

    expect(mockSql).toHaveBeenCalledWith(
      ['coalesce(', ', ', ')'],
      'mergedAtRemote',
      'updatedAt',
    );
    expect(mockGte).toHaveBeenCalledWith(
      expect.objectContaining({ expression: 'mergedAt' }),
      expect.any(Date),
    );
  });

  it('includes both login and display-name Roomote attribution in report details', async () => {
    mockMergedPullRequestRows.mockResolvedValue([
      {
        ...MERGED_PR_ROWS[0],
        attributionBody:
          '> <!-- roomote:pr-attribution:start -->Opened on behalf of @daniel-lxs.<!-- roomote:pr-attribution:end -->',
      },
      {
        ...MERGED_PR_ROWS[1],
        attributionBody:
          '> <!-- roomote:pr-attribution:start -->Opened on behalf of Daniel Riccio.<!-- roomote:pr-attribution:end -->',
      },
    ]);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });

    await announcerJob({ manualTrigger: true });

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            description: expect.stringContaining(
              'opened on behalf of @daniel-lxs',
            ),
          }),
        }),
      }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            description: expect.stringContaining(
              'opened on behalf of Daniel Riccio',
            ),
          }),
        }),
      }),
    );
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

  it('ignores installation A before any outcome and launches the manager report for owner B', async () => {
    mockSlackInstallationRows.mockResolvedValue([
      { slackBotToken: 'xoxb-a', slackTeamId: 'T-A' },
      { slackBotToken: 'xoxb-b', slackTeamId: 'T-B' },
    ]);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C-MANAGER',
      teamId: 'T-B',
      source: 'manager_channel',
    });
    mockGetAutomationRuntime.mockImplementation(async () => ({
      key: 'announcer',
      enabled: mockRecordAutomationRunOutcome.mock.calls.length === 0,
      scheduleMode: 'daily',
      lastRunAt: null,
      instructions: null,
      destination: null,
    }));
    const result = await announcerJob();
    expect(result.completed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            teamId: 'T-B',
            slackChannel: 'C-MANAGER',
          }),
        }),
      }),
    );
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledTimes(1);
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'succeeded' }),
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

  it('routes same-name repositories by their persisted repository IDs', async () => {
    const secondRepositoryId = '22222222-2222-4222-8222-222222222222';
    mockMergedPullRequestRows.mockResolvedValue([
      MERGED_PR_ROWS[0],
      {
        ...MERGED_PR_ROWS[1],
        repositoryId: secondRepositoryId,
        sourceControlProvider: 'gitlab',
        host: 'gitlab.example.com',
        prUrl: 'https://gitlab.example.com/acme/app/-/merge_requests/2',
      },
    ]);
    mockActiveRepositoryRows.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        fullName: 'acme/app',
        sourceControlProvider: 'github',
        host: null,
      },
      {
        id: secondRepositoryId,
        fullName: 'acme/app',
        sourceControlProvider: 'gitlab',
        host: 'gitlab.example.com',
      },
    ]);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100555',
    });
    mockResolveAutomationRepositoryDestination.mockImplementation(
      async ({ repositoryId }) => ({
        provider: 'telegram',
        channelId: repositoryId === secondRepositoryId ? '-100222' : '-100111',
      }),
    );

    await announcerJob({ manualTrigger: true });

    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);
    expect(
      mockResolveAutomationRepositoryDestination.mock.calls.map(
        ([params]) => params.repositoryId,
      ),
    ).toEqual(['11111111-1111-4111-8111-111111111111', secondRepositoryId]);
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

describe('getRoomotePullRequestAttribution', () => {
  it.each([
    [
      '<!-- roomote:pr-attribution:start -->Opened on behalf of @daniel-lxs.<!-- roomote:pr-attribution:end -->',
      { login: 'daniel-lxs', displayName: null },
    ],
    [
      '<!-- roomote:pr-attribution:start -->Opened on behalf of Daniel Riccio.<!-- roomote:pr-attribution:end -->',
      { login: null, displayName: 'Daniel Riccio' },
    ],
  ])('parses %s', (body, expected) => {
    expect(getRoomotePullRequestAttribution(body)).toEqual(expected);
  });
});

const {
  mockEnqueueTask,
  mockRecordAutomationRunOutcome,
  mockPartitionActiveRepositoriesByProvider,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
  mockPartitionActiveRepositoriesByProvider: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/cloud-agents/server')>();

  return {
    ...actual,
    enqueueTask: mockEnqueueTask,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {},
  recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
}));

vi.mock('../github-deployment-scope', () => ({
  partitionActiveRepositoriesByProvider:
    mockPartitionActiveRepositoriesByProvider,
}));

import { buildSuggestedTasksPrompt } from '@roomote/cloud-agents/server';
import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import { dispatchSuggestionRoutes } from '../suggester-route-dispatch';

function buildParams() {
  return {
    deployment: {
      slackBotToken: 'xoxb-test',
      slackTeamId: 'T-1',
    },
    previousSuggestions: [
      {
        title: 'Scope legacy run tokens to their own task',
        brief: 'Legacy run tokens can still reach unrelated task APIs.',
        status: 'open' as const,
      },
    ],
    repositoryCoverage: [
      {
        repositoryFullName: 'acme/api',
        targetEnvironmentId: 'env-1',
      },
    ],
    repositoryFullNames: ['acme/api'],
    routePlan: {
      routes: [
        {
          channelId: 'C123SUGGEST',
          channelName: 'C123SUGGEST',
          excludedGroupLabels: [],
          groupLabel: null,
          isFallbackRoute: false,
          isLegacyRoute: true,
          recentThreadFeedback: null,
          routeInstructions: null,
          suggesterInstructions: 'Prioritize auth and data-loss failures.',
        },
      ],
      loadRecentThreadFeedbackForChannel: vi
        .fn()
        .mockResolvedValue('Manager feedback'),
    },
    triggerKind: 'scheduled' as const,
  };
}

describe('dispatchSuggestionRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T03:00:00.000Z'));

    mockEnqueueTask.mockResolvedValue({ id: 1, taskId: 'task-1' });
    mockRecordAutomationRunOutcome.mockResolvedValue(undefined);
    mockPartitionActiveRepositoriesByProvider.mockResolvedValue([
      {
        provider: 'github',
        host: null,
        repositoryFullNames: ['acme/api'],
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues a legacy route and records a successful pass on the automations row', async () => {
    const params = buildParams();

    const result = await dispatchSuggestionRoutes(params);

    expect(result).toEqual({
      successfulRoutes: 1,
      firstLaunchedTaskId: 'task-1',
      errors: [],
    });
    expect(
      params.routePlan.loadRecentThreadFeedbackForChannel,
    ).toHaveBeenCalledWith('C123SUGGEST');
    expect(mockEnqueueTask).toHaveBeenCalledWith({
      task: {
        type: TaskPayloadKind.Scan,
        payload: {
          repo: ALL_REPOSITORIES,
          selectedRepositories: ['acme/api'],
          sourceControlProvider: 'github',
          teamId: 'T-1',
          description: buildSuggestedTasksPrompt({
            repositoryFullNames: ['acme/api'],
            repositoryCoverage: [
              {
                repositoryFullName: 'acme/api',
                targetEnvironmentId: 'env-1',
              },
            ],
            routeContext: null,
            setupGuidance: null,
            suggesterInstructions: 'Prioritize auth and data-loss failures.',
            previousSuggestions: [
              {
                title: 'Scope legacy run tokens to their own task',
                brief: 'Legacy run tokens can still reach unrelated task APIs.',
                status: 'open',
              },
            ],
            recentThreadFeedback: 'Manager feedback',
          }),
          trigger: 'scheduled',
          notifySlack: true,
          slackChannel: 'C123SUGGEST',
          suggestionSource: 'suggest_ideas',
          visibleInTranscript: false,
        },
      },
      initiator: { kind: 'automation', key: 'suggester' },
      workflow: 'scan',
      surface: 'system',
      trigger: 'schedule',
      visibility: 'hidden',
      channels: { slackChannelId: 'C123SUGGEST' },
    });
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: 'suggester',
        status: 'succeeded',
        at: new Date('2026-04-09T03:00:00.000Z'),
      }),
    );
  });

  it('launches one stamped scan per provider partition when the route scope spans providers', async () => {
    const params = {
      ...buildParams(),
      repositoryFullNames: ['acme/api', 'acme/mobile'],
      repositoryCoverage: [
        { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-1' },
        { repositoryFullName: 'acme/mobile', targetEnvironmentId: 'env-2' },
      ],
    };
    mockPartitionActiveRepositoriesByProvider.mockResolvedValue([
      {
        provider: 'bitbucket',
        host: 'bitbucket.org',
        repositoryFullNames: ['acme/api'],
      },
      {
        provider: 'ado',
        host: 'dev.azure.com',
        repositoryFullNames: ['acme/mobile'],
      },
    ]);
    mockEnqueueTask
      .mockResolvedValueOnce({ id: 1, taskId: 'task-bitbucket' })
      .mockResolvedValueOnce({ id: 2, taskId: 'task-ado' });

    const result = await dispatchSuggestionRoutes(params);

    expect(result).toEqual({
      successfulRoutes: 1,
      firstLaunchedTaskId: 'task-bitbucket',
      errors: [],
    });
    expect(mockPartitionActiveRepositoriesByProvider).toHaveBeenCalledWith([
      'acme/api',
      'acme/mobile',
    ]);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);

    const [firstCall, secondCall] = mockEnqueueTask.mock.calls.map(
      ([input]) => input.task.payload,
    );

    expect(firstCall).toMatchObject({
      selectedRepositories: ['acme/api'],
      sourceControlProvider: 'bitbucket',
      sourceControlHost: 'bitbucket.org',
    });
    expect(firstCall.description).toContain('acme/api');
    expect(firstCall.description).not.toContain('acme/mobile');
    expect(secondCall).toMatchObject({
      selectedRepositories: ['acme/mobile'],
      sourceControlProvider: 'ado',
      sourceControlHost: 'dev.azure.com',
    });
    expect(secondCall.description).toContain('acme/mobile');
  });

  it('fails the route without enqueueing when no active repositories match the scope', async () => {
    const params = buildParams();
    mockPartitionActiveRepositoriesByProvider.mockResolvedValue([]);

    const result = await dispatchSuggestionRoutes(params);

    expect(result.successfulRoutes).toBe(0);
    expect(result.errors).toEqual([
      'C123SUGGEST: No active repositories matched the route repository scope.',
    ]);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('fans out grouped routes and reports per-route failures without stopping later routes', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadRecentThreadFeedbackForChannel = vi
      .fn()
      .mockImplementation(async (channelId: string) =>
        channelId === 'G123PRIVATE'
          ? 'Infra route feedback'
          : 'Product route feedback',
      );
    const params = {
      ...buildParams(),
      routePlan: {
        routes: [
          {
            channelId: 'G123PRIVATE',
            channelName: '#eng-private',
            excludedGroupLabels: ['Product polish'],
            groupLabel: 'Incidents',
            isFallbackRoute: false,
            isLegacyRoute: false,
            recentThreadFeedback: null,
            routeInstructions:
              'Focus on alerts, outages, and reliability work that should stay private.',
            suggesterInstructions: null,
          },
          {
            channelId: 'C123PRODUCT',
            channelName: '#product-eng',
            excludedGroupLabels: ['Incidents'],
            groupLabel: 'Product polish',
            isFallbackRoute: false,
            isLegacyRoute: false,
            recentThreadFeedback: null,
            routeInstructions: 'Focus on onboarding friction and UX polish.',
            suggesterInstructions: null,
          },
        ],
        loadRecentThreadFeedbackForChannel,
      },
    };
    mockEnqueueTask
      .mockRejectedValueOnce(new Error('queue failed'))
      .mockResolvedValueOnce({ taskId: 'task-2' });

    const result = await dispatchSuggestionRoutes(params);

    expect(result).toEqual({
      successfulRoutes: 1,
      firstLaunchedTaskId: 'task-2',
      errors: ['Incidents: queue failed'],
    });
    expect(loadRecentThreadFeedbackForChannel).toHaveBeenNthCalledWith(
      1,
      'G123PRIVATE',
    );
    expect(loadRecentThreadFeedbackForChannel).toHaveBeenNthCalledWith(
      2,
      'C123PRODUCT',
    );
    // One successful route still counts the pass as a run.
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: 'suggester',
        status: 'succeeded',
      }),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '[suggester] Failed route Incidents: queue failed',
    );

    consoleSpy.mockRestore();
  });

  it('omits Slack channel metadata when the destination is Telegram', async () => {
    const params = {
      ...buildParams(),
      routePlan: {
        ...buildParams().routePlan,
        routes: [
          {
            ...buildParams().routePlan.routes[0]!,
            channelId: '-100123',
            channelName: '-100123',
          },
        ],
      },
      destinationPayloadFields: {
        communicationProvider: 'telegram',
        communicationChannelId: '-100123',
      },
    };

    await dispatchSuggestionRoutes(params);

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationProvider: 'telegram',
            communicationChannelId: '-100123',
            notifySlack: true,
            suggestionSource: 'suggest_ideas',
          }),
        }),
      }),
    );
    const enqueueArg = mockEnqueueTask.mock.calls[0]![0] as {
      task: { payload: Record<string, unknown> };
      channels?: { slackChannelId?: string };
    };
    expect(enqueueArg.task.payload.slackChannel).toBeUndefined();
    expect(enqueueArg.channels).toBeUndefined();
  });

  it('records a failed pass when every route fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const params = buildParams();
    mockEnqueueTask.mockRejectedValue(new Error('queue failed'));

    const result = await dispatchSuggestionRoutes(params);

    expect(result).toEqual({
      successfulRoutes: 0,
      firstLaunchedTaskId: null,
      errors: ['C123SUGGEST: queue failed'],
    });
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: 'suggester',
        status: 'failed',
        error: 'C123SUGGEST: queue failed',
      }),
    );

    consoleSpy.mockRestore();
  });
});

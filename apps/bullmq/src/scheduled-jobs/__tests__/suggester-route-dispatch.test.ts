const {
  mockEnqueueCloudTask,
  mockStartBackgroundAutomationRun,
  mockCompleteBackgroundAutomationRun,
  mockCompleteBackgroundAutomationRunByJobId,
} = vi.hoisted(() => ({
  mockEnqueueCloudTask: vi.fn(),
  mockStartBackgroundAutomationRun: vi.fn(),
  mockCompleteBackgroundAutomationRun: vi.fn(),
  mockCompleteBackgroundAutomationRunByJobId: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/cloud-agents/server')>();

  return {
    ...actual,
    enqueueCloudTask: mockEnqueueCloudTask,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {},
  startBackgroundAutomationRun: mockStartBackgroundAutomationRun,
  completeBackgroundAutomationRun: mockCompleteBackgroundAutomationRun,
  completeBackgroundAutomationRunByJobId:
    mockCompleteBackgroundAutomationRunByJobId,
}));

import { buildSuggestedTasksPrompt } from '@roomote/cloud-agents/server';
import { ALL_REPOSITORIES, CloudTaskType } from '@roomote/types';

import { dispatchSuggestionRoutes } from '../suggester-route-dispatch';

function buildParams() {
  return {
    deployment: {
      slackBotToken: 'xoxb-test',
      slackTeamId: 'T-1',
    },
    previousSuggestions: [
      {
        title: 'Scope legacy job tokens to their own task',
        brief: 'Legacy job tokens can still reach unrelated task APIs.',
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
          bullmqJobId: 'suggester:org-1:test',
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

    mockStartBackgroundAutomationRun.mockResolvedValue({ id: 'run-1' });
    mockEnqueueCloudTask.mockResolvedValue({ id: 1, taskId: 'task-1' });
    mockCompleteBackgroundAutomationRun.mockResolvedValue(null);
    mockCompleteBackgroundAutomationRunByJobId.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues a legacy route and completes the run lifecycle on success', async () => {
    const params = buildParams();

    const result = await dispatchSuggestionRoutes(params);

    expect(result).toEqual({ successfulRoutes: 1, errors: [] });
    expect(
      params.routePlan.loadRecentThreadFeedbackForChannel,
    ).toHaveBeenCalledWith('C123SUGGEST');
    expect(mockStartBackgroundAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        automationKey: 'suggester',
        bullmqJobId: 'suggester:org-1:test',
        triggerKind: 'scheduled',
        metadata: {
          routeChannelId: 'C123SUGGEST',
          routeChannelName: 'C123SUGGEST',
          routeGroupLabel: null,
          routeKind: 'legacy',
        },
      }),
    );
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      {
        userId: null,
        type: CloudTaskType.SuggestedTasks,
        payload: {
          repo: ALL_REPOSITORIES,
          selectedRepositories: ['acme/api'],
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
                title: 'Scope legacy job tokens to their own task',
                brief: 'Legacy job tokens can still reach unrelated task APIs.',
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
      {
        launchClass: 'automation',
      },
    );
    expect(mockCompleteBackgroundAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 'run-1',
        automationKey: 'suggester',
        status: 'succeeded',
        finishedAt: new Date('2026-04-09T03:00:00.000Z'),
        taskId: 'task-1',
        slackChannelId: 'C123SUGGEST',
        metadata: {
          cloudJobId: 1,
          routeChannelName: 'C123SUGGEST',
          routeGroupLabel: null,
          routeKind: 'legacy',
        },
      }),
    );
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
            bullmqJobId: 'suggester:org-1:test:route:1',
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
            bullmqJobId: 'suggester:org-1:test:route:2',
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
    mockStartBackgroundAutomationRun
      .mockResolvedValueOnce({ id: 'run-1' })
      .mockResolvedValueOnce({ id: 'run-2' });
    mockEnqueueCloudTask
      .mockRejectedValueOnce(new Error('queue failed'))
      .mockResolvedValueOnce({ taskId: 'task-2' });

    const result = await dispatchSuggestionRoutes(params);

    expect(result).toEqual({
      successfulRoutes: 1,
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
    expect(mockCompleteBackgroundAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 'run-1',
        automationKey: 'suggester',
        status: 'failed',
        error: 'queue failed',
        slackChannelId: 'G123PRIVATE',
      }),
    );
    expect(mockCompleteBackgroundAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 'run-2',
        automationKey: 'suggester',
        status: 'succeeded',
        taskId: 'task-2',
        slackChannelId: 'C123PRODUCT',
      }),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '[suggester] Failed route Incidents: queue failed',
    );

    consoleSpy.mockRestore();
  });

  it('marks the route failed by BullMQ job id when run creation fails', async () => {
    const params = buildParams();
    mockStartBackgroundAutomationRun.mockRejectedValue(
      new Error('run start failed'),
    );

    const result = await dispatchSuggestionRoutes(params);

    expect(result).toEqual({
      successfulRoutes: 0,
      errors: ['C123SUGGEST: run start failed'],
    });
    expect(mockCompleteBackgroundAutomationRun).not.toHaveBeenCalled();
    expect(mockCompleteBackgroundAutomationRunByJobId).toHaveBeenCalledWith(
      expect.anything(),
      {
        automationKey: 'suggester',
        bullmqJobId: 'suggester:org-1:test',
        status: 'failed',
        finishedAt: new Date('2026-04-09T03:00:00.000Z'),
        error: 'run start failed',
      },
    );
  });
});

const {
  mockPlanSuggestionRoutes,
  mockGetChannelName,
  mockListAccessibleChannels,
  mockLoadAutomationThreadFeedbackReport,
} = vi.hoisted(() => ({
  mockPlanSuggestionRoutes: vi.fn(),
  mockGetChannelName: vi.fn(),
  mockListAccessibleChannels: vi.fn(),
  mockLoadAutomationThreadFeedbackReport: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  planSuggestionRoutes: mockPlanSuggestionRoutes,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(function SlackNotifier() {
    return {
      getChannelName: mockGetChannelName,
      listAccessibleChannels: mockListAccessibleChannels,
    };
  }),
}));

vi.mock('../automation-thread-feedback', () => ({
  loadAutomationThreadFeedbackReport: mockLoadAutomationThreadFeedbackReport,
}));

import { prepareSuggestionDispatchPlan } from '../suggester-route-planner';

function buildParams() {
  return {
    groupedRoutingEnabled: true,
    managerChannelId: 'C123MANAGER',
    now: new Date('2026-04-09T03:00:00.000Z'),
    deployment: {
      slackBotToken: 'xoxb-test',
      slackTeamId: 'T-1',
    },
    repositoryCoverage: [
      {
        repositoryFullName: 'acme/api',
        workspaceReadiness: 'environment_backed' as const,
        targetEnvironmentId: 'env-1',
      },
    ],
    settings: {
      suggesterInstructions: 'Keep the legacy single-route guidance.',
      suggesterRoutingInstructions:
        'Incidents -> #eng-private. Product polish -> #product-eng.',
      suggesterRoutingMode: 'group_by_instructions',
    },
  };
}

describe('prepareSuggestionDispatchPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockListAccessibleChannels.mockResolvedValue([
      { id: 'C123MANAGER', name: 'roomote-managers' },
      { id: 'G123PRIVATE', name: 'eng-private' },
      { id: 'C123PRODUCT', name: 'product-eng' },
    ]);
    mockGetChannelName.mockImplementation(async (channelId: string) => {
      const channelNames: Record<string, string> = {
        C123MANAGER: 'roomote-managers',
        G123PRIVATE: 'eng-private',
        C123PRODUCT: 'product-eng',
      };

      return channelNames[channelId] ?? null;
    });
    mockLoadAutomationThreadFeedbackReport.mockImplementation(
      async ({ slackChannelId }: { slackChannelId: string }) => ({
        promptText:
          slackChannelId === 'G123PRIVATE'
            ? 'Infra route feedback'
            : slackChannelId === 'C123PRODUCT'
              ? 'Product route feedback'
              : 'Manager feedback',
        debugSnippet: '',
        threadCount: 0,
        feedbackMessageCount: 0,
      }),
    );
  });

  it('plans grouped routes and caches per-channel feedback lookups', async () => {
    mockPlanSuggestionRoutes.mockResolvedValue({
      fallbackChannelId: 'C123MANAGER',
      fallbackChannelName: 'roomote-managers',
      fallbackInstructions: null,
      issues: [],
      routes: [
        {
          groupLabel: 'Incidents',
          channelId: 'G123PRIVATE',
          channelName: 'eng-private',
          routeInstructions:
            'Focus on alerts, outages, and reliability work that should stay private.',
          confidence: 0.91,
        },
        {
          groupLabel: 'Product polish',
          channelId: 'C123PRODUCT',
          channelName: 'product-eng',
          routeInstructions: 'Focus on onboarding friction and UX polish.',
          confidence: 0.87,
        },
      ],
    });

    const plan = await prepareSuggestionDispatchPlan(buildParams());

    expect(mockPlanSuggestionRoutes).toHaveBeenCalledWith({
      routingInstructions:
        'Incidents -> #eng-private. Product polish -> #product-eng.',
      availableChannels: [
        { id: 'C123MANAGER', name: 'roomote-managers' },
        { id: 'G123PRIVATE', name: 'eng-private' },
        { id: 'C123PRODUCT', name: 'product-eng' },
      ],
      managerFallbackChannel: {
        id: 'C123MANAGER',
        name: 'roomote-managers',
      },
      repositoryCoverage: [
        {
          repositoryFullName: 'acme/api',
          workspaceReadiness: 'environment_backed',
          targetEnvironmentId: 'env-1',
        },
      ],
    });
    expect(plan.routes).toEqual([
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
    ]);

    expect(mockLoadAutomationThreadFeedbackReport).toHaveBeenCalledTimes(1);
    expect(await plan.loadRecentThreadFeedbackForChannel('C123MANAGER')).toBe(
      'Manager feedback',
    );
    expect(mockLoadAutomationThreadFeedbackReport).toHaveBeenCalledTimes(1);
    expect(await plan.loadRecentThreadFeedbackForChannel('G123PRIVATE')).toBe(
      'Infra route feedback',
    );
    expect(await plan.loadRecentThreadFeedbackForChannel('G123PRIVATE')).toBe(
      'Infra route feedback',
    );
    expect(mockLoadAutomationThreadFeedbackReport).toHaveBeenCalledTimes(2);
  });

  it('adds a manager fallback route when grouped planning returns fallback instructions', async () => {
    mockPlanSuggestionRoutes.mockResolvedValue({
      fallbackChannelId: 'C123MANAGER',
      fallbackChannelName: 'roomote-managers',
      fallbackInstructions:
        'Handle ideas that are ambiguous or do not clearly match another group.',
      issues: ['Fallback required for uncategorized ideas.'],
      routes: [
        {
          groupLabel: 'Incidents',
          channelId: 'G123PRIVATE',
          channelName: 'eng-private',
          routeInstructions: 'Focus on alerts, outages, and reliability work.',
          confidence: 0.91,
        },
      ],
    });

    const plan = await prepareSuggestionDispatchPlan(buildParams());

    expect(plan.routes).toEqual([
      expect.objectContaining({
        channelId: 'G123PRIVATE',
        groupLabel: 'Incidents',
      }),
      {
        channelId: 'C123MANAGER',
        channelName: '#roomote-managers',
        excludedGroupLabels: ['Incidents'],
        groupLabel: 'Manager fallback',
        isFallbackRoute: true,
        isLegacyRoute: false,
        recentThreadFeedback: null,
        routeInstructions:
          'Handle ideas that are ambiguous or do not clearly match another group.',
        suggesterInstructions: null,
      },
    ]);
  });

  it('falls back to the legacy manager-channel route when no grouped routes are accepted', async () => {
    mockPlanSuggestionRoutes.mockResolvedValue({
      fallbackChannelId: 'C123MANAGER',
      fallbackChannelName: 'roomote-managers',
      fallbackInstructions:
        'Use the manager channel for anything that does not map cleanly.',
      issues: ['Could not map routes confidently.'],
      routes: [],
    });

    const plan = await prepareSuggestionDispatchPlan(buildParams());

    expect(plan.routes).toEqual([
      {
        channelId: 'C123MANAGER',
        channelName: 'C123MANAGER',
        excludedGroupLabels: [],
        groupLabel: null,
        isFallbackRoute: false,
        isLegacyRoute: true,
        recentThreadFeedback: null,
        routeInstructions: null,
        suggesterInstructions: 'Keep the legacy single-route guidance.',
      },
    ]);
  });

  it('falls back to the legacy manager-channel route when Slack channel discovery fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockListAccessibleChannels.mockRejectedValue(
      new Error('Slack channel lookup failed'),
    );

    const plan = await prepareSuggestionDispatchPlan(buildParams());

    expect(mockPlanSuggestionRoutes).not.toHaveBeenCalled();
    expect(plan.routes).toEqual([
      {
        channelId: 'C123MANAGER',
        channelName: 'C123MANAGER',
        excludedGroupLabels: [],
        groupLabel: null,
        isFallbackRoute: false,
        isLegacyRoute: true,
        recentThreadFeedback: null,
        routeInstructions: null,
        suggesterInstructions: 'Keep the legacy single-route guidance.',
      },
    ]);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Falling back to the manager channel for deployment: Slack channel lookup failed',
      ),
    );

    consoleWarn.mockRestore();
  });
});

const {
  mockDispatchSuggestionScan,
  mockFindEnvironmentIdForRepositoryId,
  mockGetActiveRepositoriesForProviders,
  mockGetAutomationRuntime,
  mockListConnectedCommunicationProviders,
  mockResolveAutomationRepositoryDestination,
  mockResolveAutomationRuntimeDestination,
  mockSlackInstallationRows,
  slackInstallationsTable,
  workItemsTable,
} = vi.hoisted(() => ({
  mockDispatchSuggestionScan: vi.fn(),
  mockFindEnvironmentIdForRepositoryId: vi.fn(),
  mockGetActiveRepositoriesForProviders: vi.fn(),
  mockGetAutomationRuntime: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockResolveAutomationRepositoryDestination: vi.fn(),
  mockResolveAutomationRuntimeDestination: vi.fn(),
  mockSlackInstallationRows: vi.fn(),
  slackInstallationsTable: {
    botAccessToken: 'botAccessToken',
    teamId: 'teamId',
    isActive: 'isActive',
  },
  workItemsTable: {
    kind: 'kind',
    status: 'status',
    createdAt: 'createdAt',
    title: 'title',
    brief: 'brief',
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === slackInstallationsTable) {
          return { where: () => mockSlackInstallationRows() };
        }

        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve([]),
          then: (resolve: (rows: unknown) => unknown) =>
            Promise.resolve([{ openSuggestionCount: 0 }]).then(resolve),
        };
        return chain;
      },
    })),
  },
  slackInstallations: slackInstallationsTable,
  workItems: workItemsTable,
  getAutomationRuntime: mockGetAutomationRuntime,
  and: vi.fn(),
  count: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  gte: vi.fn(),
}));

vi.mock('../github-deployment-scope', () => ({
  hasAnyActiveRepository: vi.fn(async () => true),
  getActiveRepositoriesForProviders: mockGetActiveRepositoriesForProviders,
  findEnvironmentIdForRepositoryId: mockFindEnvironmentIdForRepositoryId,
}));

vi.mock('../destination', () => ({
  buildDestinationTaskPayloadFields: vi.fn(() => ({ teamId: 'T-B' })),
  listConnectedCommunicationProviders: mockListConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination: mockResolveAutomationRuntimeDestination,
}));

vi.mock('../ci-failure-triage-routing', () => ({
  resolveAutomationRepositoryDestination:
    mockResolveAutomationRepositoryDestination,
}));

vi.mock('../custom-automation-schedule', () => ({
  resolveDeploymentTimeZone: vi.fn(async () => ({ timeZone: 'UTC' })),
}));

vi.mock('../scheduling-utils', () => ({
  isRunDue: vi.fn(() => true),
}));

vi.mock('../suggester-dispatch', () => ({
  dispatchSuggestionScan: mockDispatchSuggestionScan,
}));

import { suggesterJob } from '../suggester';

describe('suggesterJob repository routing', () => {
  it('dispatches a routed Slack group once under its owning workspace', async () => {
    const repositoryId = '11111111-1111-4111-8111-111111111111';
    const rulesText = 'Send acme/api suggestions to the Team B workspace.';
    mockSlackInstallationRows.mockResolvedValue([
      { slackBotToken: 'xoxb-a', slackTeamId: 'T-A' },
      { slackBotToken: 'xoxb-b', slackTeamId: 'T-B' },
    ]);
    mockGetAutomationRuntime.mockResolvedValue({
      key: 'suggester',
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      instructions: null,
      settings: {
        additionalRules: rulesText,
        compiledRules: {
          text: rulesText,
          repositoryIds: [repositoryId],
          destinations: [
            {
              repositoryId,
              target: {
                provider: 'slack',
                externalRef: 'C-TEAM-B',
                workspaceId: 'T-B',
              },
            },
          ],
          instructions: '',
        },
      },
    });
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C-DEFAULT',
      teamId: 'T-A',
    });
    mockListConnectedCommunicationProviders.mockResolvedValue(['slack']);
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: repositoryId,
        fullName: 'acme/api',
        sourceControlProvider: 'github',
        host: 'github.com',
      },
    ]);
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue('env-api');
    mockResolveAutomationRepositoryDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C-TEAM-B',
      teamId: 'T-B',
      source: 'automation_target',
    });
    mockDispatchSuggestionScan.mockResolvedValue({
      errors: [],
      firstLaunchedTaskId: 'task-1',
      successfulScans: 1,
    });

    const result = await suggesterJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBe('task-1');
    expect(mockDispatchSuggestionScan).toHaveBeenCalledTimes(1);
    expect(mockDispatchSuggestionScan).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment: { slackBotToken: 'xoxb-b', slackTeamId: 'T-B' },
        channelId: 'C-TEAM-B',
        destinationPayloadFields: { teamId: 'T-B' },
      }),
    );
  });
});

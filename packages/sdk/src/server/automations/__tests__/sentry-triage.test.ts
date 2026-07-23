const {
  mockDbSelect,
  mockGetAutomationTargetRefs,
  mockGetActiveRepositoryFullNames,
  mockPartitionActiveRepositoriesByProvider,
  mockBuildRepositoryCoverage,
  mockLoadAutomationThreadFeedbackReport,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockGetAutomationTargetRefs: vi.fn(),
  mockGetActiveRepositoryFullNames: vi.fn(),
  mockPartitionActiveRepositoriesByProvider: vi.fn(),
  mockBuildRepositoryCoverage: vi.fn(),
  mockLoadAutomationThreadFeedbackReport: vi.fn(),
}));

// Capture the triage config so buildScanTask is directly callable.
vi.mock('../scheduled-triage-runner', () => ({
  createScheduledTriageJob: (config: unknown) => config,
}));

vi.mock('@roomote/db/server', () => ({
  db: { select: mockDbSelect },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((...args: unknown[]) => args),
  getAutomationTargetRefs: mockGetAutomationTargetRefs,
  mcpConnections: {
    id: 'id',
    mcpId: 'mcpId',
    enabled: 'enabled',
    authStatus: 'authStatus',
    userId: 'userId',
  },
}));

vi.mock('../github-deployment-scope', () => ({
  getActiveRepositoryFullNames: mockGetActiveRepositoryFullNames,
  partitionActiveRepositoriesByProvider:
    mockPartitionActiveRepositoriesByProvider,
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/cloud-agents/server')>();

  return {
    ...actual,
    buildRepositoryCoverage: mockBuildRepositoryCoverage,
  };
});

vi.mock('../automation-thread-feedback', () => ({
  loadAutomationThreadFeedbackReport: mockLoadAutomationThreadFeedbackReport,
}));

import { ALL_REPOSITORIES } from '@roomote/types';

import { sentryTriageJob } from '../sentry-triage';

type TriageConfig = {
  automationKey: string;
  buildScanTask: (params: {
    deployment: { slackBotToken: string | null; slackTeamId: string | null };
    channelId: string;
    destination: { provider: 'slack'; channelId: string };
    runtime: Record<string, unknown>;
    manualTrigger: boolean;
  }) => Promise<
    | { kind: 'scan'; payloads: Record<string, unknown>[] }
    | { kind: 'skip'; reason: string }
  >;
};

const config = sentryTriageJob as unknown as TriageConfig;

function mockSentryConnection(connected: boolean) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(connected ? [{ id: 'conn-1' }] : []),
  };
  mockDbSelect.mockReturnValue(chain);
}

function buildScanTaskParams() {
  return {
    deployment: { slackBotToken: 'xoxb-test', slackTeamId: 'T-1' },
    channelId: 'C123MANAGER',
    destination: { provider: 'slack' as const, channelId: 'C123MANAGER' },
    runtime: { scheduleMode: 'daily', instructions: null, settings: {} },
    manualTrigger: false,
  };
}

describe('sentryTriageJob buildScanTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSentryConnection(true);
    mockGetAutomationTargetRefs.mockReturnValue([]);
    mockLoadAutomationThreadFeedbackReport.mockResolvedValue({
      promptText: null,
      debugSnippet: null,
    });
  });

  it('launches one stamped scan per provider partition when the scope spans providers', async () => {
    mockGetActiveRepositoryFullNames.mockResolvedValue([
      'roomote/stoodio-bitbucket',
      'roomote/Test ADO/Test ADO',
    ]);
    mockBuildRepositoryCoverage.mockResolvedValue([
      {
        repositoryFullName: 'roomote/stoodio-bitbucket',
        targetEnvironmentId: 'env-bitbucket',
      },
      {
        repositoryFullName: 'roomote/Test ADO/Test ADO',
        targetEnvironmentId: 'env-ado',
      },
    ]);
    mockPartitionActiveRepositoriesByProvider.mockResolvedValue([
      {
        provider: 'ado',
        host: 'dev.azure.com',
        repositoryFullNames: ['roomote/Test ADO/Test ADO'],
      },
      {
        provider: 'bitbucket',
        host: 'bitbucket.org',
        repositoryFullNames: ['roomote/stoodio-bitbucket'],
      },
    ]);

    const result = await config.buildScanTask(buildScanTaskParams());

    expect(result.kind).toBe('scan');

    if (result.kind !== 'scan') {
      throw new Error('expected a scan build');
    }

    expect(result.payloads).toHaveLength(2);
    expect(mockPartitionActiveRepositoriesByProvider).toHaveBeenCalledWith([
      'roomote/stoodio-bitbucket',
      'roomote/Test ADO/Test ADO',
    ]);

    const [adoPayload, bitbucketPayload] = result.payloads;

    expect(adoPayload).toMatchObject({
      repo: ALL_REPOSITORIES,
      selectedRepositories: ['roomote/Test ADO/Test ADO'],
      sourceControlProvider: 'ado',
      sourceControlHost: 'dev.azure.com',
      suggestionSource: 'sentry_triage',
    });
    expect(String(adoPayload!.description)).toContain(
      'roomote/Test ADO/Test ADO',
    );
    expect(String(adoPayload!.description)).not.toContain(
      'roomote/stoodio-bitbucket',
    );
    expect(bitbucketPayload).toMatchObject({
      selectedRepositories: ['roomote/stoodio-bitbucket'],
      sourceControlProvider: 'bitbucket',
      sourceControlHost: 'bitbucket.org',
    });
    expect(String(bitbucketPayload!.description)).toContain(
      'roomote/stoodio-bitbucket',
    );
    expect(String(bitbucketPayload!.description)).not.toContain(
      'roomote/Test ADO/Test ADO',
    );
  });

  it('keeps a single unstamped scan when no repository is environment-backed', async () => {
    mockGetActiveRepositoryFullNames.mockResolvedValue(['acme/api']);
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/api' },
    ]);
    mockPartitionActiveRepositoriesByProvider.mockResolvedValue([]);

    const result = await config.buildScanTask(buildScanTaskParams());

    expect(result.kind).toBe('scan');

    if (result.kind !== 'scan') {
      throw new Error('expected a scan build');
    }

    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0]).not.toHaveProperty('selectedRepositories');
    expect(result.payloads[0]).not.toHaveProperty('sourceControlProvider');
  });

  it('skips when Sentry MCP is not connected', async () => {
    mockSentryConnection(false);

    const result = await config.buildScanTask(buildScanTaskParams());

    expect(result).toEqual({
      kind: 'skip',
      reason: 'Sentry MCP is not configured',
    });
  });
});

const {
  mockHasActiveGitHubInstallation,
  mockGetActiveGitHubRepositoryFullNames,
  mockBuildRepositoryCoverage,
  mockLoadAutomationThreadFeedbackContext,
} = vi.hoisted(() => ({
  mockHasActiveGitHubInstallation: vi.fn(),
  mockGetActiveGitHubRepositoryFullNames: vi.fn(),
  mockBuildRepositoryCoverage: vi.fn(),
  mockLoadAutomationThreadFeedbackContext: vi.fn(),
}));

// Capture the triage config so buildScanTask is directly callable.
vi.mock('../scheduled-triage-runner', () => ({
  createScheduledTriageJob: (config: unknown) => config,
}));

vi.mock('../github-deployment-scope', () => ({
  hasActiveGitHubInstallation: mockHasActiveGitHubInstallation,
  getActiveGitHubRepositoryFullNames: mockGetActiveGitHubRepositoryFullNames,
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
  loadAutomationThreadFeedbackContext: mockLoadAutomationThreadFeedbackContext,
}));

import { ALL_REPOSITORIES } from '@roomote/types';

import { dependabotTriageJob } from '../dependabot-triage';

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

const config = dependabotTriageJob as unknown as TriageConfig;

function buildScanTaskParams() {
  return {
    deployment: { slackBotToken: 'xoxb-test', slackTeamId: 'T-1' },
    channelId: 'C123MANAGER',
    destination: { provider: 'slack' as const, channelId: 'C123MANAGER' },
    runtime: {},
    manualTrigger: false,
  };
}

describe('dependabotTriageJob buildScanTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasActiveGitHubInstallation.mockResolvedValue(true);
    mockLoadAutomationThreadFeedbackContext.mockResolvedValue(null);
  });

  it('scopes the scan to environment-backed GitHub repositories and stamps the provider', async () => {
    mockGetActiveGitHubRepositoryFullNames.mockResolvedValue([
      'acme/api',
      'acme/no-environment',
    ]);
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-1' },
      { repositoryFullName: 'acme/no-environment' },
    ]);

    const result = await config.buildScanTask(buildScanTaskParams());

    expect(result.kind).toBe('scan');

    if (result.kind !== 'scan') {
      throw new Error('expected a scan build');
    }

    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0]).toMatchObject({
      repo: ALL_REPOSITORIES,
      selectedRepositories: ['acme/api'],
      sourceControlProvider: 'github',
      suggestionSource: 'dependabot_triage',
    });
    // GitHub-only scope comes from the GitHub-scoped repository query, so
    // non-GitHub repositories can never enter the scan payload.
    expect(mockGetActiveGitHubRepositoryFullNames).toHaveBeenCalledTimes(1);
    expect(mockBuildRepositoryCoverage).toHaveBeenCalledWith([
      'acme/api',
      'acme/no-environment',
    ]);
  });

  it('skips when no active GitHub repository is backed by an environment', async () => {
    mockGetActiveGitHubRepositoryFullNames.mockResolvedValue([
      'acme/no-environment',
    ]);
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/no-environment' },
    ]);

    const result = await config.buildScanTask(buildScanTaskParams());

    expect(result).toEqual({
      kind: 'skip',
      reason: 'No active GitHub repositories have configured environments',
    });
  });

  it('skips when GitHub is not configured', async () => {
    mockHasActiveGitHubInstallation.mockResolvedValue(false);

    const result = await config.buildScanTask(buildScanTaskParams());

    expect(result).toEqual({
      kind: 'skip',
      reason: 'GitHub is not configured',
    });
    expect(mockGetActiveGitHubRepositoryFullNames).not.toHaveBeenCalled();
  });
});

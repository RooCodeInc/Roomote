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

  it('scans all active GitHub repositories while keeping remediation environment-backed', async () => {
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

    const [payload] = result.payloads;
    if (!payload) {
      throw new Error('expected a scan payload');
    }

    expect(result.payloads).toHaveLength(1);
    expect(payload).toMatchObject({
      repo: ALL_REPOSITORIES,
      selectedRepositories: ['acme/api', 'acme/no-environment'],
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
    expect(payload.description).toContain(
      'count its current open Dependabot alerts',
    );
    expect(payload.description).toContain('inspect its open pull requests');
    expect(payload.description).toContain(
      'After triage reaches a final result, post exactly one concise status message',
    );
    expect(payload.description).toContain(
      'total number of open Dependabot alerts with a critical/high/medium/low severity breakdown',
    );
    expect(payload.description).toContain(
      'critical/high/medium/low severity breakdown',
    );
    expect(payload.description).toContain(
      'covered by newly started remediation task(s), existing related PRs, or neither',
    );
    expect(payload.description).toContain(
      'do not submit duplicate work for alerts it covers',
    );
    expect(payload.description).toContain(
      'every eligible environment with uncovered actionable alerts',
    );
    expect(payload.description).toContain(
      'must not modify or bypass dependency minimum-age policy',
    );
    expect(payload.description).toContain('minimumReleaseAgeExclude');
    expect(payload.description).toContain(
      'Do not post any Slack opening acknowledgement, scan announcement, progress update, or partial finding',
    );
    expect(payload.description).toContain(
      'post exactly one concise status message',
    );
  });

  it('scans and reports repositories without environments without permitting remediation launches', async () => {
    mockGetActiveGitHubRepositoryFullNames.mockResolvedValue([
      'acme/no-environment',
    ]);
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/no-environment' },
    ]);

    const result = await config.buildScanTask(buildScanTaskParams());

    expect(result.kind).toBe('scan');

    if (result.kind !== 'scan') {
      throw new Error('expected a scan build');
    }

    expect(result.payloads[0]).toMatchObject({
      selectedRepositories: ['acme/no-environment'],
    });
    expect(result.payloads[0]?.description).toContain(
      'Only consider repositories that appear in the "Repository environments" list below',
    );
  });

  it('skips when there are no active GitHub repositories', async () => {
    mockGetActiveGitHubRepositoryFullNames.mockResolvedValue([]);

    const result = await config.buildScanTask(buildScanTaskParams());

    expect(result).toEqual({
      kind: 'skip',
      reason: 'No active GitHub repositories',
    });
    expect(mockBuildRepositoryCoverage).not.toHaveBeenCalled();
    expect(mockLoadAutomationThreadFeedbackContext).not.toHaveBeenCalled();
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

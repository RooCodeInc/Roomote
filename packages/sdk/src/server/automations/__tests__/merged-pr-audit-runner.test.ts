import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  slackInstallationsTable,
  mockSlackInstallationRows,
  mockHasAnyActiveRepository,
  mockGetAutomationRuntime,
  mockRecordAutomationRunOutcome,
  mockListConnectedCommunicationProviders,
  mockResolveAutomationRuntimeDestination,
  mockLoadAutomationThreadFeedbackReport,
  mockEnqueueTask,
} = vi.hoisted(() => ({
  slackInstallationsTable: {
    id: 'slackInstallations.id',
    isActive: 'isActive',
  },
  mockSlackInstallationRows: vi.fn(),
  mockHasAnyActiveRepository: vi.fn(),
  mockGetAutomationRuntime: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockResolveAutomationRuntimeDestination: vi.fn(),
  mockLoadAutomationThreadFeedbackReport: vi.fn(),
  mockEnqueueTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => mockSlackInstallationRows(),
      };
      return chain;
    }),
  },
  getAutomationRuntime: mockGetAutomationRuntime,
  recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
  updateAutomationScanCursor: vi.fn(),
  slackInstallations: slackInstallationsTable,
  pullRequestFacts: {
    externalPullRequestId: 'externalPullRequestId',
    repositoryFullName: 'repositoryFullName',
    prNumber: 'prNumber',
    title: 'title',
    htmlUrl: 'htmlUrl',
    mergedAtRemote: 'mergedAtRemote',
    repositoryId: 'repositoryId',
    state: 'state',
  },
  repositories: { id: 'repositories.id', isActive: 'repositories.isActive' },
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  gt: vi.fn(),
  gte: vi.fn(),
  isNotNull: vi.fn(),
  lte: vi.fn(),
  or: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildRepositoryCoverage: vi.fn(async () => []),
  enqueueTask: mockEnqueueTask,
  formatRepositoryEnvironmentLines: vi.fn(() => ''),
}));

vi.mock('../automation-thread-feedback', () => ({
  loadAutomationThreadFeedbackReport: mockLoadAutomationThreadFeedbackReport,
}));

vi.mock('../destination', () => ({
  buildDestinationPromptContext: vi.fn(() => ({
    channelTag: 'slack_channel',
    postToolName: 'post_to_slack_channel',
    surfaceLabel: 'Slack',
  })),
  buildDestinationTaskPayloadFields: vi.fn(() => ({})),
  listConnectedCommunicationProviders: mockListConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination: mockResolveAutomationRuntimeDestination,
}));

vi.mock('../github-deployment-scope', () => ({
  hasAnyActiveRepository: mockHasAnyActiveRepository,
}));

import {
  buildMergedPullRequestTaskContext,
  createMergedPullRequestAuditJob,
} from '../merged-pr-audit-runner';

describe('createMergedPullRequestAuditJob eligibility gate', () => {
  const job = createMergedPullRequestAuditJob({
    automationKey: 'security_auditor',
    buildPrompt: () => 'prompt',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSlackInstallationRows.mockResolvedValue([]);
    mockListConnectedCommunicationProviders.mockResolvedValue([]);
    mockGetAutomationRuntime.mockResolvedValue({
      enabled: false,
      scheduleMode: 'off',
      lastRunAt: null,
      scanCursor: null,
    });
  });

  it('skips when no active repository exists on any provider', async () => {
    mockHasAnyActiveRepository.mockResolvedValue(false);

    const result = await job();

    expect(result.skippedReason).toBe(
      'A repository and a communication provider must both be connected.',
    );
    expect(mockHasAnyActiveRepository).toHaveBeenCalled();
    expect(mockGetAutomationRuntime).not.toHaveBeenCalled();
  });

  it('skips when a repository exists but no communication provider is connected', async () => {
    mockHasAnyActiveRepository.mockResolvedValue(true);

    const result = await job();

    expect(result.skippedReason).toBe(
      'A repository and a communication provider must both be connected.',
    );
  });

  it('treats a non-GitHub repository with a non-Slack comms provider as eligible', async () => {
    mockHasAnyActiveRepository.mockResolvedValue(true);
    mockListConnectedCommunicationProviders.mockResolvedValue(['teams']);

    const result = await job();

    // The deployment is eligible; the run then stops at the disabled
    // automation runtime rather than the repository gate.
    expect(mockGetAutomationRuntime).toHaveBeenCalledWith('security_auditor');
    expect(result.skippedReason).toBe('Automation is disabled.');
  });
});

describe('buildMergedPullRequestTaskContext', () => {
  it('describes the manifest source provider-neutrally', () => {
    const context = buildMergedPullRequestTaskContext({
      channelId: 'C123',
      destination: {
        provider: 'slack',
        channelId: 'C123',
      } as never,
      hasMorePullRequests: false,
      manualTrigger: false,
      mergedPullRequests: [
        {
          externalPullRequestId: 991,
          repositoryFullName: 'acme/backend',
          prNumber: 42,
          title: 'Merged MR',
          htmlUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
          mergedAt: new Date('2026-07-10T00:00:00Z'),
        },
      ],
      repositoryCoverage: [],
      scanMode: { kind: 'interval', since: new Date('2026-07-01T00:00:00Z') },
    });

    expect(context).toContain('cached pull request facts');
    expect(context).not.toContain('GitHub PR facts');
    expect(context).toContain(
      'https://gitlab.com/acme/backend/-/merge_requests/42',
    );
  });
});

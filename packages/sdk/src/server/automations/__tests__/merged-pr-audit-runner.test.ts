import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  slackInstallationsTable,
  mockSlackInstallationRows,
  mockHasAnyActiveRepository,
  mockGetAutomationRuntime,
  mockRecordAutomationRunOutcome,
  mockUpdateAutomationScanCursor,
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
  mockUpdateAutomationScanCursor: vi.fn(),
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
  updateAutomationScanCursor: mockUpdateAutomationScanCursor,
  slackInstallations: slackInstallationsTable,
  pullRequestFacts: {
    id: 'pullRequestFacts.id',
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
          sourceControlProvider: 'gitlab',
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

describe('createMergedPullRequestAuditJob provider partitioning', () => {
  const buildPrompt = vi.fn(
    (params: { mergedPullRequests: { prNumber: number }[] }): string =>
      `prompt for ${params.mergedPullRequests.length} PRs`,
  );
  const job = createMergedPullRequestAuditJob({
    automationKey: 'security_auditor',
    buildPrompt,
  });

  type FactRow = {
    factId: string;
    repositoryId: string;
    externalPullRequestId: number;
    repositoryFullName: string;
    sourceControlProvider: string;
    prNumber: number;
    title: string;
    htmlUrl: string;
    mergedAt: Date;
  };

  function factRow(params: {
    index: number;
    provider: string;
    repositoryFullName: string;
    mergedAt?: Date;
  }): FactRow {
    return {
      factId: `fact-${params.index}`,
      repositoryId: `repo-${params.provider}`,
      externalPullRequestId: params.index + 1,
      repositoryFullName: params.repositoryFullName,
      sourceControlProvider: params.provider,
      prNumber: params.index + 1,
      title: `PR ${params.index + 1}`,
      htmlUrl: `https://example.com/${params.repositoryFullName}/pulls/${params.index + 1}`,
      mergedAt:
        params.mergedAt ??
        new Date(Date.parse('2026-07-10T00:00:00Z') + params.index * 60_000),
    };
  }

  function enqueuedPayloads() {
    return mockEnqueueTask.mock.calls.map(
      ([{ task }]) => task.payload as Record<string, unknown>,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasAnyActiveRepository.mockResolvedValue(true);
    // First select: active Slack installations; second select: merged facts.
    mockSlackInstallationRows.mockResolvedValueOnce([{ id: 'slack-1' }]);
    mockGetAutomationRuntime.mockResolvedValue({
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      scanCursor: null,
    });
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123',
    });
    mockLoadAutomationThreadFeedbackReport.mockResolvedValue({
      promptText: null,
      debugSnippet: undefined,
    });
    let enqueueCount = 0;
    mockEnqueueTask.mockImplementation(async () => ({
      taskId: `task-${enqueueCount++}`,
    }));
  });

  it('launches one task per source-control provider with the provider stamped on non-GitHub payloads', async () => {
    mockSlackInstallationRows.mockResolvedValueOnce([
      factRow({ index: 0, provider: 'github', repositoryFullName: 'acme/gh' }),
      factRow({ index: 1, provider: 'gitlab', repositoryFullName: 'acme/gl' }),
      factRow({ index: 2, provider: 'github', repositoryFullName: 'acme/gh' }),
    ]);

    const result = await job();

    expect(result.errors).toEqual([]);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);

    const [githubPayload, gitlabPayload] = enqueuedPayloads();

    // GitHub partition launches with the pre-partitioning payload shape: the
    // provider field is absent entirely, not merely undefined.
    expect('sourceControlProvider' in githubPayload!).toBe(false);
    expect(githubPayload!.selectedRepositories).toEqual(['acme/gh']);

    expect(gitlabPayload!.sourceControlProvider).toBe('gitlab');
    expect(gitlabPayload!.selectedRepositories).toEqual(['acme/gl']);

    // Each task's prompt manifest carries only its own provider's PRs.
    const manifests = buildPrompt.mock.calls.map(([params]) =>
      params.mergedPullRequests.map((pullRequest) => pullRequest.prNumber),
    );
    expect(manifests).toEqual([[1, 3], [2]]);

    expect(result.launchedTaskId).toBe('task-0');
  });

  it('launches a single task without the provider field for an all-GitHub manifest', async () => {
    mockSlackInstallationRows.mockResolvedValueOnce([
      factRow({ index: 0, provider: 'github', repositoryFullName: 'acme/a' }),
      factRow({ index: 1, provider: 'github', repositoryFullName: 'acme/b' }),
    ]);

    const result = await job();

    expect(result.errors).toEqual([]);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);

    const [payload] = enqueuedPayloads();
    expect('sourceControlProvider' in payload!).toBe(false);
    expect(payload!.selectedRepositories).toEqual(['acme/a', 'acme/b']);
    expect(mockUpdateAutomationScanCursor).not.toHaveBeenCalled();
  });

  it('advances the page cursor once, after every partition has launched', async () => {
    // 251 rows overflow the 250-row page; providers alternate so both
    // partitions interleave across the whole page.
    const rows = Array.from({ length: 251 }, (_, index) =>
      factRow({
        index,
        provider: index % 2 === 0 ? 'github' : 'gitlab',
        repositoryFullName: index % 2 === 0 ? 'acme/gh' : 'acme/gl',
      }),
    );
    // Distinct PR identity per row within each repository.
    mockSlackInstallationRows.mockResolvedValueOnce(rows);

    const result = await job();

    expect(result.errors).toEqual([]);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);

    // The cursor covers the full 250-row page (last included row, index 249)
    // even though that page was split across two launches.
    expect(mockUpdateAutomationScanCursor).toHaveBeenCalledTimes(1);
    const cursorArgs = mockUpdateAutomationScanCursor.mock.calls[0]![1];
    expect(cursorArgs.cursor).toEqual({
      mergedAt: rows[249]!.mergedAt.toISOString(),
      factId: 'fact-249',
      externalPullRequestId: 250,
    });

    // Cursor write happens only after both partition launches.
    const cursorOrder =
      mockUpdateAutomationScanCursor.mock.invocationCallOrder[0]!;
    for (const enqueueOrder of mockEnqueueTask.mock.invocationCallOrder) {
      expect(cursorOrder).toBeGreaterThan(enqueueOrder);
    }
  });

  it('leaves the cursor untouched when a partition launch fails', async () => {
    const rows = Array.from({ length: 251 }, (_, index) =>
      factRow({
        index,
        provider: index % 2 === 0 ? 'github' : 'gitlab',
        repositoryFullName: index % 2 === 0 ? 'acme/gh' : 'acme/gl',
      }),
    );
    mockSlackInstallationRows.mockResolvedValueOnce(rows);
    mockEnqueueTask
      .mockResolvedValueOnce({ taskId: 'task-github' })
      .mockRejectedValueOnce(new Error('enqueue exploded'));

    const result = await job();

    // The run fails without checkpointing, so the next run rescans the same
    // page instead of skipping the partition that never launched.
    expect(result.errors).toEqual(['enqueue exploded']);
    expect(mockUpdateAutomationScanCursor).not.toHaveBeenCalled();
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', lastRunAt: 'skip' }),
    );
  });
});

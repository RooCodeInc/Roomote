import type { Mock } from 'vitest';

const {
  mockGetCommitCommittedAt,
  mockGetInstallationOctokit,
  mockIsRepoSkipped,
  mockEnqueueTask,
  mockFindActiveGitHubBranchWork,
  mockHasRecentGitHubBranchCommit,
  mockSelectLimit,
  mockSelectWhere,
  mockFindInstallation,
  mockGetAutomationRuntime,
  mockRecordAutomationRunOutcome,
} = vi.hoisted(() => {
  type AnyMock = Mock<(...args: never[]) => unknown>;

  return {
    mockGetCommitCommittedAt: vi.fn() as AnyMock,
    mockGetInstallationOctokit: vi.fn() as AnyMock,
    mockIsRepoSkipped: vi.fn() as AnyMock,
    mockEnqueueTask: vi.fn() as AnyMock,
    mockFindActiveGitHubBranchWork: vi.fn() as AnyMock,
    mockHasRecentGitHubBranchCommit: vi.fn() as AnyMock,
    mockSelectLimit: vi.fn() as AnyMock,
    mockSelectWhere: vi.fn() as AnyMock,
    mockFindInstallation: vi.fn() as AnyMock,
    mockGetAutomationRuntime: vi.fn() as AnyMock,
    mockRecordAutomationRunOutcome: vi.fn() as AnyMock,
  };
});

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      R_APP_URL: 'https://app.roomote.dev',
    },
  };
});

vi.mock('@roomote/github', () => ({
  getCommitCommittedAt: mockGetCommitCommittedAt,
  getInstallationOctokit: mockGetInstallationOctokit,
  isRepoSkipped: mockIsRepoSkipped,
}));

vi.mock('@roomote/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/types')>();

  return {
    ...actual,
    AUTO_RESOLVE_CONFLICTS_LABEL: 'auto-resolve-conflicts',
    CONFLICT_RESOLUTION_COMMENT_MARKER: '<!-- conflict-resolution -->',
    DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS: 7,
    DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS: 30,
    RunStatus: {
      Pending: 'pending',
      Running: 'running',
    },
  };
});

vi.mock('@roomote/db/server', () => {
  const where = vi.fn((...args: never[]) => ({
    limit: (...limitArgs: never[]) => mockSelectLimit(...limitArgs),
    then: (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve(mockSelectWhere(...args)).then(onFulfilled, onRejected),
  }));
  const chain: { where: typeof where; innerJoin?: unknown } = { where };
  chain.innerJoin = vi.fn(() => chain);
  const from = vi.fn(() => chain);
  const select = vi.fn(() => ({ from }));
  const updateSet = vi.fn(() => ({
    where: vi.fn().mockResolvedValue(undefined),
  }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    db: {
      select,
      update,
      query: {
        githubInstallations: {
          findFirst: mockFindInstallation,
        },
      },
    },
    githubInstallations: {
      installationId: 'installationId',
      suspendedAt: 'suspendedAt',
    },
    githubUserMappings: {
      githubUserId: 'githubUserId',
    },
    repositories: {
      fullName: 'fullName',
      installationId: 'installationId',
    },
    tasks: {
      id: 'id',
      workflow: 'workflow',
    },
    taskPullRequests: {
      taskId: 'taskId',
      sourceControlProvider: 'sourceControlProvider',
      repository: 'repository',
      prNumber: 'prNumber',
    },
    taskRuns: {
      id: 'id',
      taskId: 'taskId',
      status: 'status',
    },
    DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS: 30 * 60 * 1000,
    DEFAULT_CONFLICT_RESOLVER_LABEL: 'auto-resolve-conflicts',
    findActiveGitHubBranchWork: mockFindActiveGitHubBranchWork,
    hasRecentGitHubBranchCommit: mockHasRecentGitHubBranchCommit,
    getAutomationRuntime: mockGetAutomationRuntime,
    recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
    isNull: vi.fn(),
    eq: vi.fn(),
    and: vi.fn(),
    inArray: vi.fn(),
  };
});

import { conflictScanJob } from '../conflict-scan';

describe('conflictScanJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetAutomationRuntime.mockResolvedValue({
      key: 'conflict_resolver',
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      instructions: null,
      settings: {
        label: 'auto-resolve-conflicts',
        maxPrAgeDays: 7,
      },
      targets: [],
      scanCursor: null,
      slackChannelId: null,
      managerSlackChannelId: null,
    });
    mockFindInstallation.mockResolvedValue({ id: 'install-row-1' });
    mockSelectWhere
      .mockResolvedValueOnce([{ orgId: 'org-1', installationId: 123 }])
      .mockResolvedValueOnce([
        { fullName: 'Roomote/example-app', orgId: 'org-1' },
      ])
      .mockResolvedValue([]);
    mockSelectLimit.mockResolvedValue([]);
    mockFindActiveGitHubBranchWork.mockResolvedValue(null);
    mockGetCommitCommittedAt.mockResolvedValue(
      new Date('2026-03-17T20:00:00.000Z'),
    );
    mockHasRecentGitHubBranchCommit.mockReturnValue(false);
    mockRecordAutomationRunOutcome.mockResolvedValue(undefined);

    mockGetInstallationOctokit.mockResolvedValue({
      paginate: vi.fn().mockResolvedValue([]),
      rest: {
        pulls: {
          get: vi.fn(),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    });
  });

  it('skips repos in GITHUB_AUTOMATED_SKIP_REPOS before scanning PRs', async () => {
    mockIsRepoSkipped.mockReturnValue(true);

    await conflictScanJob();

    expect(mockIsRepoSkipped).toHaveBeenCalledWith('Roomote/example-app');
    expect(mockGetInstallationOctokit).toHaveBeenCalledOnce();

    const octokit = await mockGetInstallationOctokit.mock.results[0]!.value;
    expect(octokit.paginate).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('continues scanning repos that are not skipped', async () => {
    mockIsRepoSkipped.mockReturnValue(false);

    await conflictScanJob();

    const octokit = await mockGetInstallationOctokit.mock.results[0]!.value;
    expect(octokit.paginate).toHaveBeenCalledOnce();
  });

  it('records the pass outcome on the automations row', async () => {
    mockIsRepoSkipped.mockReturnValue(false);

    await conflictScanJob();

    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: 'conflict_resolver',
        status: 'skipped',
      }),
    );
  });

  it('skips the pass when the automation is disabled', async () => {
    // This pass exits before the repo lookup, so rebuild the select queue
    // without the queued repos row to keep later tests' queues aligned.
    mockSelectWhere.mockReset();
    mockSelectWhere.mockResolvedValue([
      { orgId: 'org-1', installationId: 123 },
    ]);
    mockGetAutomationRuntime.mockResolvedValue({
      key: 'conflict_resolver',
      enabled: false,
      scheduleMode: null,
      lastRunAt: null,
      instructions: null,
      settings: {},
      targets: [],
      scanCursor: null,
      slackChannelId: null,
      managerSlackChannelId: null,
    });

    const result = await conflictScanJob();

    expect(result.skippedReason).toBe('Automation is disabled.');
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    expect(mockRecordAutomationRunOutcome).not.toHaveBeenCalled();
  });

  it('skips conflicting PRs when another Roomote task is active on the branch', async () => {
    mockIsRepoSkipped.mockReturnValue(false);
    mockFindActiveGitHubBranchWork.mockResolvedValueOnce({
      runId: 77,
      taskId: 'task-77',
      type: 'standard.task',
      status: 'running',
      taskPhase: 'running',
      match: 'branch',
    });

    const octokit = {
      paginate: vi.fn().mockResolvedValue([
        {
          number: 42,
          draft: true,
          title: 'Draft PR',
          html_url: 'https://github.com/Roomote/example-app/pull/42',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          labels: [{ name: 'auto-resolve-conflicts' }],
          head: { ref: 'feature/work', sha: 'abc1234' },
          base: { ref: 'main' },
          user: { login: 'author', id: 123 },
        },
      ]),
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { mergeable: false } }),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    mockGetInstallationOctokit.mockResolvedValueOnce(octokit);

    await conflictScanJob();

    expect(mockFindActiveGitHubBranchWork).toHaveBeenCalledWith({
      repoFullName: 'Roomote/example-app',
      prNumber: 42,
      branchName: 'feature/work',
    });
    expect(mockGetCommitCommittedAt).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips conflicting PRs when the branch has a recent commit', async () => {
    mockIsRepoSkipped.mockReturnValue(false);
    mockGetCommitCommittedAt.mockResolvedValueOnce(
      new Date('2026-03-17T21:50:00.000Z'),
    );
    mockHasRecentGitHubBranchCommit.mockReturnValueOnce(true);

    const octokit = {
      paginate: vi.fn().mockResolvedValue([
        {
          number: 42,
          draft: false,
          title: 'PR 42',
          html_url: 'https://github.com/Roomote/example-app/pull/42',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          labels: [{ name: 'auto-resolve-conflicts' }],
          head: { ref: 'feature/work', sha: 'abc1234' },
          base: { ref: 'main' },
          user: { login: 'author', id: 123 },
        },
      ]),
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { mergeable: false } }),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    mockGetInstallationOctokit.mockResolvedValueOnce(octokit);

    await conflictScanJob();

    expect(mockGetCommitCommittedAt).toHaveBeenCalledWith({
      octokit,
      owner: 'Roomote',
      repo: 'example-app',
      ref: 'abc1234',
    });
    expect(mockHasRecentGitHubBranchCommit).toHaveBeenCalledWith({
      latestCommitAt: new Date('2026-03-17T21:50:00.000Z'),
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('looks up fork PR head commits in the head repository', async () => {
    mockIsRepoSkipped.mockReturnValue(false);

    const octokit = {
      paginate: vi.fn().mockResolvedValue([
        {
          number: 42,
          draft: false,
          title: 'PR 42',
          html_url: 'https://github.com/Roomote/example-app/pull/42',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          labels: [{ name: 'auto-resolve-conflicts' }],
          head: {
            ref: 'feature/work',
            sha: 'abc1234',
            repo: {
              name: 'roomote-fork',
              owner: { login: 'fork-owner' },
            },
          },
          base: { ref: 'main' },
          user: { login: 'author', id: 123 },
        },
      ]),
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { mergeable: false } }),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    mockGetInstallationOctokit.mockResolvedValueOnce(octokit);

    await conflictScanJob();

    expect(mockGetCommitCommittedAt).toHaveBeenCalledWith({
      octokit,
      owner: 'fork-owner',
      repo: 'roomote-fork',
      ref: 'abc1234',
    });
  });

  it('enqueues conflict-resolution tasks as the conflict_resolver automation with the PR author as actor', async () => {
    mockIsRepoSkipped.mockReturnValue(false);
    mockSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'agent-1', orgId: 'org-1' }]);
    mockEnqueueTask.mockResolvedValueOnce({ id: 1, taskId: 'task-1' });

    const octokit = {
      paginate: vi.fn().mockResolvedValue([
        {
          number: 42,
          draft: false,
          title: 'PR 42',
          html_url: 'https://github.com/Roomote/example-app/pull/42',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          labels: [{ name: 'auto-resolve-conflicts' }],
          head: { ref: 'feature/work', sha: 'abc1234' },
          base: { ref: 'main' },
          user: { login: 'author', id: 123 },
        },
      ]),
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { mergeable: false } }),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    mockGetInstallationOctokit.mockResolvedValueOnce(octokit);

    const result = await conflictScanJob();

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'github_pr_conflict_resolve',
          githubLogin: 'author',
          githubUserId: 123,
        }),
        initiator: {
          kind: 'automation',
          key: 'conflict_resolver',
          actor: { externalId: '123', displayName: 'author' },
        },
        workflow: 'pr_conflict_resolve',
        surface: 'github',
        trigger: 'schedule',
        prLinkage: expect.objectContaining({
          provider: 'github',
          repository: 'Roomote/example-app',
          prNumber: 42,
          prUrl: 'https://github.com/Roomote/example-app/pull/42',
          prSha: 'abc1234',
          prBaseRef: 'main',
        }),
      }),
    );
    expect(mockEnqueueTask.mock.calls[0]?.[0]).not.toHaveProperty('userId');
    expect(result.launchedTaskId).toBe('task-1');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'Roomote',
        repo: 'example-app',
        issue_number: 42,
      }),
    );
  });

  it('skips PRs opened before the configured automatic resolution age cap', async () => {
    mockIsRepoSkipped.mockReturnValue(false);
    const oldCreatedAt = new Date();
    oldCreatedAt.setDate(oldCreatedAt.getDate() - 8);

    const octokit = {
      paginate: vi.fn().mockResolvedValue([
        {
          number: 42,
          draft: false,
          title: 'Old PR 42',
          html_url: 'https://github.com/Roomote/example-app/pull/42',
          created_at: oldCreatedAt.toISOString(),
          updated_at: new Date().toISOString(),
          labels: [{ name: 'auto-resolve-conflicts' }],
          head: { ref: 'feature/work', sha: 'abc1234' },
          base: { ref: 'main' },
          user: { login: 'author', id: 123 },
        },
      ]),
      rest: {
        pulls: {
          get: vi.fn(),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    mockGetInstallationOctokit.mockResolvedValueOnce(octokit);

    await conflictScanJob();

    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(mockGetCommitCommittedAt).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });
});

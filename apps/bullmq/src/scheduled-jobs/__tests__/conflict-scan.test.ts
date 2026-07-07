import type { Mock } from 'vitest';

const {
  mockGetRedis,
  mockGetCommitCommittedAt,
  mockGetInstallationOctokit,
  mockIsRepoSkipped,
  mockEnqueueCloudTask,
  mockFindActiveGitHubBranchWork,
  mockHasRecentGitHubBranchCommit,
  mockSelectLimit,
  mockSelectWhere,
  mockFindInstallation,
  mockGetBackgroundAgentSettingsForOrg,
  mockStartBackgroundAutomationRun,
  mockCompleteBackgroundAutomationRun,
  mockCompleteBackgroundAutomationRunByJobId,
} = vi.hoisted(() => {
  type AnyMock = Mock<(...args: never[]) => unknown>;

  return {
    mockGetRedis: vi.fn(() => ({})) as AnyMock,
    mockGetCommitCommittedAt: vi.fn() as AnyMock,
    mockGetInstallationOctokit: vi.fn() as AnyMock,
    mockIsRepoSkipped: vi.fn() as AnyMock,
    mockEnqueueCloudTask: vi.fn() as AnyMock,
    mockFindActiveGitHubBranchWork: vi.fn() as AnyMock,
    mockHasRecentGitHubBranchCommit: vi.fn() as AnyMock,
    mockSelectLimit: vi.fn() as AnyMock,
    mockSelectWhere: vi.fn() as AnyMock,
    mockFindInstallation: vi.fn() as AnyMock,
    mockGetBackgroundAgentSettingsForOrg: vi.fn() as AnyMock,
    mockStartBackgroundAutomationRun: vi.fn() as AnyMock,
    mockCompleteBackgroundAutomationRun: vi.fn() as AnyMock,
    mockCompleteBackgroundAutomationRunByJobId: vi.fn() as AnyMock,
  };
});

vi.mock('../../redis', () => ({
  getRedis: mockGetRedis,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: mockEnqueueCloudTask,
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      ROOMOTE_APP_URL: 'https://app.roomote.dev',
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
    CloudTaskType: {
      GithubPrConflictResolve: 'github.pr.conflict.resolve',
    },
    CloudTaskStatus: {
      Pending: 'pending',
      Running: 'running',
    },
    CloudAgentType: {
      Fixer: 'fixer',
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
  const from = vi.fn(() => ({ where }));
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
    backgroundAgentSettings: {},
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
    cloudJobs: {
      id: 'id',
      type: 'type',
      prRepo: 'prRepo',
      prNumber: 'prNumber',
      status: 'status',
    },
    DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS: 30 * 60 * 1000,
    findActiveGitHubBranchWork: mockFindActiveGitHubBranchWork,
    hasRecentGitHubBranchCommit: mockHasRecentGitHubBranchCommit,
    startBackgroundAutomationRun: mockStartBackgroundAutomationRun,
    completeBackgroundAutomationRun: mockCompleteBackgroundAutomationRun,
    completeBackgroundAutomationRunByJobId:
      mockCompleteBackgroundAutomationRunByJobId,
    isNull: vi.fn(),
    eq: vi.fn(),
    and: vi.fn(),
    inArray: vi.fn(),
    getBackgroundAgentSettingsForDeployment:
      mockGetBackgroundAgentSettingsForOrg,
  };
});

import { conflictScanJob } from '../conflict-scan';

describe('conflictScanJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetBackgroundAgentSettingsForOrg.mockResolvedValue({
      conflictResolverFrequency: 'daily',
      conflictResolverMaxPrAgeDays: 7 as const,
      conflictResolverLabel: 'auto-resolve-conflicts',
      conflictResolverLastRunAt: null,
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
    mockStartBackgroundAutomationRun.mockResolvedValue({ id: 'run-1' });
    mockCompleteBackgroundAutomationRun.mockResolvedValue(undefined);
    mockCompleteBackgroundAutomationRunByJobId.mockResolvedValue(null);

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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('continues scanning repos that are not skipped', async () => {
    mockIsRepoSkipped.mockReturnValue(false);

    await conflictScanJob();

    const octokit = await mockGetInstallationOctokit.mock.results[0]!.value;
    expect(octokit.paginate).toHaveBeenCalledOnce();
  });

  it('skips conflicting PRs when another Roomote task is active on the branch', async () => {
    mockIsRepoSkipped.mockReturnValue(false);
    mockFindActiveGitHubBranchWork.mockResolvedValueOnce({
      jobId: 77,
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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
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

  it('enqueues autonomous conflict-resolution tasks without a linked Roomote userId', async () => {
    mockIsRepoSkipped.mockReturnValue(false);
    mockSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'agent-1', orgId: 'org-1' }]);
    mockEnqueueCloudTask.mockResolvedValueOnce({ id: 1, taskId: 'task-1' });

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

    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'github.pr.conflict.resolve',
        githubLogin: 'author',
        githubUserId: 123,
      }),
    );
    expect(mockEnqueueCloudTask.mock.calls[0]?.[0]).not.toHaveProperty(
      'userId',
    );
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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });
});

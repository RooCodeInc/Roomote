import { RunStatus } from '@roomote/types';

const {
  mockFindFirstLinkage,
  mockFindFirstRun,
  mockDbUpdate,
  mockDbUpdateSet,
  mockDbUpdateWhere,
  mockCreateCheck,
  mockUpdateInstallationCheck,
  mockUpdateCheckRun,
} = vi.hoisted(() => ({
  mockFindFirstLinkage: vi.fn(),
  mockFindFirstRun: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbUpdateSet: vi.fn(),
  mockDbUpdateWhere: vi.fn(),
  mockCreateCheck: vi.fn(),
  mockUpdateInstallationCheck: vi.fn(),
  mockUpdateCheckRun: vi.fn(),
}));

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );
  return {
    ...actual,
    db: {
      query: {
        taskPullRequests: { findFirst: mockFindFirstLinkage },
        taskRuns: { findFirst: mockFindFirstRun },
      },
      update: mockDbUpdate,
    },
  };
});

vi.mock('@roomote/github', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/github')>('@roomote/github');
  return {
    ...actual,
    getInstallationOctokit: vi.fn().mockResolvedValue({
      rest: {
        checks: {
          create: mockCreateCheck,
          update: mockUpdateInstallationCheck,
        },
      },
    }),
    updateCheckRun: mockUpdateCheckRun,
  };
});

vi.mock('@roomote/cloud-agents/server', async () => {
  const actual = await vi.importActual<
    typeof import('@roomote/cloud-agents/server')
  >('@roomote/cloud-agents/server');
  return {
    ...actual,
    getTaskUrl: vi.fn().mockReturnValue('https://roomote.test/task/task-1'),
  };
});

import {
  getGithubPrReviewCheckResult,
  markGithubPrReviewCheckInProgress,
  publishGithubPrReviewCheck,
} from '../github-pr-review-check';

describe('GitHub PR review check lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbUpdate.mockReturnValue({ set: mockDbUpdateSet });
    mockDbUpdateSet.mockReturnValue({ where: mockDbUpdateWhere });
    mockDbUpdateWhere.mockResolvedValue(undefined);
    mockFindFirstRun.mockResolvedValue(undefined);
  });

  it('publishes a queued check, persists its id, and supersedes the old head', async () => {
    mockFindFirstLinkage.mockResolvedValue({ githubCheckRunId: 10 });
    mockCreateCheck.mockResolvedValue({ data: { id: 20 } });

    await publishGithubPrReviewCheck({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'new-head',
      taskId: 'task-1',
      runId: 2,
    });

    expect(mockCreateCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        head_sha: 'new-head',
        status: 'queued',
        details_url: 'https://roomote.test/task/task-1',
      }),
    );
    expect(mockDbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ githubCheckRunId: 20 }),
    );
    expect(mockUpdateInstallationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 10,
        status: 'completed',
        conclusion: 'cancelled',
      }),
    );
  });

  it('marks the persisted check in progress when its worker starts', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      repository: 'owner/repo',
    });

    await markGithubPrReviewCheckInProgress({
      taskId: 'task-1',
      gitHubToken: 'token',
    });

    expect(mockUpdateCheckRun).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({
        check_run_id: 20,
        status: 'in_progress',
        details_url: 'https://roomote.test/task/task-1',
      }),
    );
  });

  it('reconciles a worker that started before the queued check id was persisted', async () => {
    const startedAt = new Date('2026-08-25T12:00:00.000Z');
    mockFindFirstLinkage.mockResolvedValue({ githubCheckRunId: null });
    mockFindFirstRun.mockResolvedValue({ startedAt });
    mockCreateCheck.mockResolvedValue({ data: { id: 20 } });

    await publishGithubPrReviewCheck({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'new-head',
      taskId: 'task-1',
      runId: 2,
    });

    expect(mockUpdateInstallationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 20,
        status: 'in_progress',
        started_at: startedAt.toISOString(),
      }),
    );
  });
});

describe('getGithubPrReviewCheckResult', () => {
  it('passes a completed review with no unresolved findings', () => {
    expect(
      getGithubPrReviewCheckResult({
        runStatus: RunStatus.Completed,
        reviewSummaryBody:
          '<!-- roomote-review-summary sha=abc -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
        safetyNetFinalized: false,
      }),
    ).toMatchObject({ conclusion: 'success' });
  });

  it('fails a completed review with unresolved findings', () => {
    expect(
      getGithubPrReviewCheckResult({
        runStatus: RunStatus.Completed,
        reviewSummaryBody:
          '<!-- roomote-review-summary sha=abc -->\n<!-- roomote-review-checklist:start -->\n- [ ] Fix the authorization check\n<!-- roomote-review-checklist:end -->',
        safetyNetFinalized: false,
      }),
    ).toMatchObject({ conclusion: 'failure', title: 'Roomote found issues' });
  });

  it('fails when the task completed without a trustworthy review result', () => {
    expect(
      getGithubPrReviewCheckResult({
        runStatus: RunStatus.Completed,
        reviewSummaryBody: 'Review complete.',
        safetyNetFinalized: true,
      }),
    ).toMatchObject({ conclusion: 'failure' });
  });

  it('fails when the review summary covers an older pull request head', () => {
    expect(
      getGithubPrReviewCheckResult({
        runStatus: RunStatus.Completed,
        reviewSummaryBody:
          '<!-- roomote-review-summary sha=abc123 -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
        safetyNetFinalized: false,
        expectedHeadSha: 'def456',
      }),
    ).toMatchObject({
      conclusion: 'failure',
      title: 'Roomote review result is stale',
    });
  });

  it.each([
    [RunStatus.Failed, 'failure'],
    [RunStatus.Canceled, 'cancelled'],
  ] as const)('maps %s runs to %s checks', (runStatus, conclusion) => {
    expect(
      getGithubPrReviewCheckResult({
        runStatus,
        safetyNetFinalized: false,
      }),
    ).toMatchObject({ conclusion });
  });
});

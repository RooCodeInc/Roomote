import { RunStatus } from '@roomote/types';

const {
  mockFindFirstLinkage,
  mockFindFirstRun,
  mockDbUpdate,
  mockDbUpdateSet,
  mockDbUpdateWhere,
  mockCreateCheck,
  mockGetCheck,
  mockGetIssueComment,
  mockUpdateInstallationCheck,
  mockUpdateCheckRun,
} = vi.hoisted(() => ({
  mockFindFirstLinkage: vi.fn(),
  mockFindFirstRun: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbUpdateSet: vi.fn(),
  mockDbUpdateWhere: vi.fn(),
  mockCreateCheck: vi.fn(),
  mockGetCheck: vi.fn(),
  mockGetIssueComment: vi.fn(),
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
          get: mockGetCheck,
          update: mockUpdateInstallationCheck,
        },
        issues: { getComment: mockGetIssueComment },
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
  completeGithubPrReviewCheckFromSummary,
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
    mockGetCheck.mockResolvedValue({
      data: { head_sha: '789abcd', status: 'in_progress' },
    });
  });

  it('publishes a queued check, persists its id, and supersedes the old head', async () => {
    mockFindFirstLinkage.mockResolvedValue({ githubCheckRunId: 10 });
    mockCreateCheck.mockResolvedValue({ data: { id: 20 } });

    await publishGithubPrReviewCheck({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      headSha: '789abcd',
      taskId: 'task-1',
      runId: 2,
    });

    expect(mockCreateCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        head_sha: '789abcd',
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
    mockFindFirstRun.mockResolvedValue({
      startedAt,
      status: RunStatus.Running,
    });
    mockCreateCheck.mockResolvedValue({ data: { id: 20 } });

    await publishGithubPrReviewCheck({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      headSha: '789abcd',
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

  it.each([undefined, 'in_progress'] as const)(
    'completes a %s check when its run settled before the check id was persisted',
    async (status) => {
      mockFindFirstLinkage.mockResolvedValue({
        githubCheckRunId: null,
        githubReviewCommentId: 30,
      });
      mockFindFirstRun.mockResolvedValue({
        startedAt: new Date('2026-08-25T12:00:00.000Z'),
        status: RunStatus.Completed,
      });
      mockCreateCheck.mockResolvedValue({ data: { id: 20 } });
      mockGetIssueComment.mockResolvedValue({
        data: {
          updated_at: '2026-08-25T12:30:00.000Z',
          body: '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
        },
      });

      await publishGithubPrReviewCheck({
        installationId: 1,
        repository: 'owner/repo',
        prNumber: 42,
        headSha: 'abcdef9',
        taskId: 'task-1',
        runId: 2,
        ...(status ? { status } : {}),
      });

      expect(mockUpdateInstallationCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 20,
          status: 'completed',
          conclusion: 'success',
        }),
      );
      expect(mockUpdateInstallationCheck).not.toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 20,
          status: 'in_progress',
        }),
      );
    },
  );

  it.each([RunStatus.Running, RunStatus.Idle])(
    'completes the check from a terminal summary while its run is %s',
    async (status) => {
      mockFindFirstLinkage
        .mockResolvedValueOnce({ githubCheckRunId: null })
        .mockResolvedValueOnce({
          githubCheckRunId: 20,
          githubReviewCommentId: 30,
        });
      mockFindFirstRun.mockResolvedValue({
        startedAt: new Date('2026-08-25T12:00:00.000Z'),
        status,
      });
      mockCreateCheck.mockResolvedValue({ data: { id: 20 } });
      mockGetIssueComment.mockResolvedValue({
        data: {
          updated_at: '2026-08-25T12:30:00.000Z',
          body: '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
        },
      });

      await publishGithubPrReviewCheck({
        installationId: 1,
        repository: 'owner/repo',
        prNumber: 42,
        headSha: 'abcdef9',
        taskId: 'task-1',
        runId: 2,
        status: 'in_progress',
      });

      expect(mockUpdateInstallationCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 20,
          status: 'completed',
          conclusion: 'success',
        }),
      );
    },
  );

  it.each([
    [RunStatus.Failed, 'failure'],
    [RunStatus.Canceled, 'cancelled'],
  ] as const)(
    'preserves a %s run conclusion when a clean terminal summary already exists',
    async (status, conclusion) => {
      mockFindFirstLinkage
        .mockResolvedValueOnce({ githubCheckRunId: null })
        .mockResolvedValueOnce({
          githubCheckRunId: 20,
          githubReviewCommentId: 30,
        });
      mockFindFirstRun.mockResolvedValue({
        startedAt: new Date('2026-08-25T12:00:00.000Z'),
        status,
      });
      mockCreateCheck.mockResolvedValue({ data: { id: 20 } });
      mockGetIssueComment.mockResolvedValue({
        data: {
          updated_at: '2026-08-25T12:30:00.000Z',
          body: '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
        },
      });

      await publishGithubPrReviewCheck({
        installationId: 1,
        repository: 'owner/repo',
        prNumber: 42,
        headSha: 'abcdef9',
        taskId: 'task-1',
        runId: 2,
        status: 'in_progress',
      });

      expect(mockUpdateInstallationCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 20,
          status: 'completed',
          conclusion,
        }),
      );
    },
  );

  it('completes a persisted check when its terminal summary webhook arrives', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      githubReviewCommentId: 30,
    });
    mockGetCheck.mockResolvedValue({
      data: {
        head_sha: 'abcdef9',
        status: 'in_progress',
        external_id: 'roomote-review:2',
      },
    });
    mockFindFirstRun.mockResolvedValue({
      startedAt: new Date('2026-08-25T12:00:00.000Z'),
      status: RunStatus.Idle,
    });
    mockGetIssueComment.mockResolvedValue({
      data: {
        updated_at: '2026-08-25T12:30:00.000Z',
        body: '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
      },
    });

    await completeGithubPrReviewCheckFromSummary({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-1',
      reviewHeadSha: 'abcdef9',
      reviewSummaryBody:
        '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
    });

    expect(mockUpdateInstallationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 20,
        status: 'completed',
        conclusion: 'success',
      }),
    );
  });

  it('does not let a delayed summary complete a newer head check', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      githubReviewCommentId: 30,
    });
    mockGetCheck.mockResolvedValue({
      data: {
        head_sha: '789abcd',
        status: 'in_progress',
        external_id: 'roomote-review:3',
      },
    });

    await completeGithubPrReviewCheckFromSummary({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-1',
      reviewHeadSha: '0123456',
      reviewSummaryBody:
        '<!-- roomote-review-summary sha=0123456 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->',
    });

    expect(mockUpdateInstallationCheck).not.toHaveBeenCalled();
  });

  it('does not overwrite an already completed check from a delayed same-head summary', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      githubReviewCommentId: 30,
    });
    mockGetCheck.mockResolvedValue({
      data: { head_sha: 'abcdef9', status: 'completed' },
    });

    await completeGithubPrReviewCheckFromSummary({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-1',
      reviewHeadSha: 'abcdef9',
      reviewSummaryBody:
        '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->',
    });

    expect(mockUpdateInstallationCheck).not.toHaveBeenCalled();
  });

  it('does not complete a fresh same-head re-review from the previous terminal summary', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: null,
      githubReviewCommentId: 30,
    });
    mockFindFirstRun.mockResolvedValue({
      startedAt: null,
      status: RunStatus.Pending,
    });
    mockCreateCheck.mockResolvedValue({ data: { id: 20 } });
    mockGetIssueComment.mockResolvedValue({
      data: {
        updated_at: '2026-08-25T12:30:00.000Z',
        body: '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
      },
    });

    await publishGithubPrReviewCheck({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'abcdef9',
      taskId: 'task-1',
      runId: 2,
    });

    expect(mockGetIssueComment).not.toHaveBeenCalled();
    expect(mockUpdateInstallationCheck).not.toHaveBeenCalled();
  });

  it('does not treat a safety-net finalized summary as a passing review', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      githubReviewCommentId: 30,
    });
    mockGetCheck.mockResolvedValue({
      data: { head_sha: 'abcdef9', status: 'in_progress' },
    });

    await completeGithubPrReviewCheckFromSummary({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-1',
      reviewHeadSha: 'abcdef9',
      reviewSummaryBody:
        '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nReview could not be completed. [See task](https://roomote.test/task/task-1)\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
    });

    expect(mockUpdateInstallationCheck).not.toHaveBeenCalled();
  });

  it('does not settle a newer same-head cycle whose run has not started', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      githubReviewCommentId: 30,
    });
    mockGetCheck.mockResolvedValue({
      data: {
        head_sha: 'abcdef9',
        status: 'queued',
        external_id: 'roomote-review:3',
      },
    });
    mockFindFirstRun.mockResolvedValue({
      startedAt: null,
      status: RunStatus.Pending,
    });

    await completeGithubPrReviewCheckFromSummary({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-1',
      reviewHeadSha: 'abcdef9',
      reviewSummaryBody:
        '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->',
    });

    expect(mockUpdateInstallationCheck).not.toHaveBeenCalled();
  });

  it('ignores a delayed terminal snapshot when the live summary is in progress again', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      githubReviewCommentId: 30,
    });
    mockGetCheck.mockResolvedValue({
      data: {
        head_sha: 'abcdef9',
        status: 'in_progress',
        external_id: 'roomote-review:3',
      },
    });
    mockFindFirstRun.mockResolvedValue({
      startedAt: new Date('2026-08-25T12:00:00.000Z'),
      status: RunStatus.Running,
    });
    mockGetIssueComment.mockResolvedValue({
      data: {
        updated_at: '2026-08-25T12:30:00.000Z',
        body: '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nRe-reviewing new commits now.\n<!-- roomote-review-status:end -->',
      },
    });

    await completeGithubPrReviewCheckFromSummary({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-1',
      reviewHeadSha: 'abcdef9',
      reviewSummaryBody:
        '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->',
    });

    expect(mockUpdateInstallationCheck).not.toHaveBeenCalled();
  });

  it('does not complete a started re-review from a terminal summary that predates it', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      githubReviewCommentId: 30,
    });
    mockGetCheck.mockResolvedValue({
      data: {
        head_sha: 'abcdef9',
        status: 'in_progress',
        external_id: 'roomote-review:3',
      },
    });
    mockFindFirstRun.mockResolvedValue({
      startedAt: new Date('2026-08-25T12:00:00.000Z'),
      status: RunStatus.Running,
    });
    mockGetIssueComment.mockResolvedValue({
      data: {
        updated_at: '2026-08-25T11:50:00.000Z',
        body: '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->',
      },
    });

    await completeGithubPrReviewCheckFromSummary({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-1',
      reviewHeadSha: 'abcdef9',
      reviewSummaryBody:
        '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->',
    });

    expect(mockUpdateInstallationCheck).not.toHaveBeenCalled();
  });

  it('publish does not complete a running re-review from a summary that predates it', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: null,
      githubReviewCommentId: 30,
    });
    mockFindFirstRun.mockResolvedValue({
      startedAt: new Date('2026-08-25T12:00:00.000Z'),
      status: RunStatus.Running,
    });
    mockCreateCheck.mockResolvedValue({ data: { id: 20 } });
    mockGetIssueComment.mockResolvedValue({
      data: {
        updated_at: '2026-08-25T11:50:00.000Z',
        body: '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
      },
    });

    await publishGithubPrReviewCheck({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'abcdef9',
      taskId: 'task-1',
      runId: 2,
    });

    expect(mockUpdateInstallationCheck).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
    expect(mockUpdateInstallationCheck).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 20, status: 'in_progress' }),
    );
  });

  it('swallows checks API failures instead of failing the webhook delivery', async () => {
    mockFindFirstLinkage.mockResolvedValue({
      githubCheckRunId: 20,
      githubReviewCommentId: 30,
    });
    mockGetCheck.mockRejectedValue(new Error('Not Found'));

    await expect(
      completeGithubPrReviewCheckFromSummary({
        installationId: 1,
        repository: 'owner/repo',
        prNumber: 42,
        taskId: 'task-1',
        reviewHeadSha: 'abcdef9',
        reviewSummaryBody:
          '<!-- roomote-review-summary sha=abcdef9 -->\n<!-- roomote-review-status:start -->\nNo code issues found.\n<!-- roomote-review-status:end -->',
      }),
    ).resolves.toBeUndefined();

    expect(mockUpdateInstallationCheck).not.toHaveBeenCalled();
  });
});

describe('getGithubPrReviewCheckResult', () => {
  it('passes a completed review with no unresolved findings', () => {
    expect(
      getGithubPrReviewCheckResult({
        runStatus: RunStatus.Completed,
        reviewSummaryBody:
          '<!-- roomote-review-summary sha=abc1234 -->\n<!-- roomote-review-status:start -->\nNo issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
        safetyNetFinalized: false,
      }),
    ).toMatchObject({ conclusion: 'success' });
  });

  it('fails a completed review with unresolved findings', () => {
    expect(
      getGithubPrReviewCheckResult({
        runStatus: RunStatus.Completed,
        reviewSummaryBody:
          '<!-- roomote-review-summary sha=abc1234 -->\n<!-- roomote-review-status:start -->\n1 issue outstanding.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n- [ ] Fix the authorization check\n<!-- roomote-review-checklist:end -->',
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
          '<!-- roomote-review-summary sha=abc1234 -->\n<!-- roomote-review-status:start -->\nNo issues found.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
        safetyNetFinalized: false,
        expectedHeadSha: 'def4567',
      }),
    ).toMatchObject({
      conclusion: 'failure',
      title: 'Roomote review result is stale',
    });
  });

  it('fails a completed run whose summary is still in progress', () => {
    expect(
      getGithubPrReviewCheckResult({
        runStatus: RunStatus.Completed,
        reviewSummaryBody:
          '<!-- roomote-review-summary sha=abc1234 -->\n<!-- roomote-review-status:start -->\nReviewing the PR now.\n<!-- roomote-review-status:end -->\n<!-- roomote-review-checklist:start -->\n<!-- roomote-review-checklist:end -->',
        safetyNetFinalized: false,
      }),
    ).toMatchObject({
      conclusion: 'failure',
      title: 'Roomote review result unavailable',
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

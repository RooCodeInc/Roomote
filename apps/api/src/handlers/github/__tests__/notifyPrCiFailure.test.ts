const {
  mockEnqueuePrReviewNotification,
  mockGetInstallationOctokit,
  mockListPullRequestsAssociatedWithCommit,
} = vi.hoisted(() => ({
  mockEnqueuePrReviewNotification: vi.fn().mockResolvedValue({
    notifiedTaskCount: 1,
  }),
  mockGetInstallationOctokit: vi.fn(),
  mockListPullRequestsAssociatedWithCommit: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  getInstallationOctokit: mockGetInstallationOctokit,
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueuePrReviewNotification: mockEnqueuePrReviewNotification,
}));

import type { WebhookCheckRunCompleted } from '../types';
import {
  buildPrCiFailureNotificationInputs,
  queuePrCiFailureNotification,
} from '../notifyPrCiFailure';

function checkRunPayload({
  conclusion = 'failure',
  pullRequestNumbers = [42],
}: {
  conclusion?: string;
  pullRequestNumbers?: number[];
} = {}): WebhookCheckRunCompleted {
  return {
    action: 'completed',
    installation: { id: 123 },
    repository: {
      full_name: 'owner/repo',
      html_url: 'https://github.com/owner/repo',
    },
    check_run: {
      id: 9001,
      name: 'CI / Tests',
      conclusion,
      head_sha: 'abc123',
      completed_at: '2026-08-23T12:00:00.000Z',
      details_url: 'https://github.com/owner/repo/actions/runs/7/job/8',
      html_url: 'https://github.com/owner/repo/runs/9001',
      app: { name: 'GitHub Actions', slug: 'github-actions' },
      pull_requests: pullRequestNumbers.map((number) => ({ number })),
    },
  } as unknown as WebhookCheckRunCompleted;
}

describe('buildPrCiFailureNotificationInputs', () => {
  it('normalizes failed checks for each associated pull request', () => {
    expect(
      buildPrCiFailureNotificationInputs(
        checkRunPayload({ pullRequestNumbers: [42, 43, 42] }),
      ),
    ).toEqual([
      expect.objectContaining({
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: {
          kind: 'ci_failure',
          providerEventId: 'github-check-run:9001',
          authorLogin: 'github-actions',
          checkName: 'CI / Tests',
          reviewHeadSha: 'abc123',
          url: 'https://github.com/owner/repo/actions/runs/7/job/8',
          observedAt: Date.parse('2026-08-23T12:00:00.000Z'),
        },
      }),
      expect.objectContaining({ prNumber: 43 }),
    ]);
  });

  it.each(['success', 'neutral', 'cancelled', 'skipped'])(
    'ignores a %s check conclusion',
    (conclusion) => {
      expect(
        buildPrCiFailureNotificationInputs(checkRunPayload({ conclusion })),
      ).toEqual([]);
    },
  );

  it('ignores failed checks that GitHub did not associate with a PR', () => {
    expect(
      buildPrCiFailureNotificationInputs(
        checkRunPayload({ pullRequestNumbers: [] }),
      ),
    ).toEqual([]);
  });
});

describe('queuePrCiFailureNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationOctokit.mockResolvedValue({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit:
            mockListPullRequestsAssociatedWithCommit,
        },
      },
    });
  });

  it('persists failures through the existing PR notification pipeline', async () => {
    await queuePrCiFailureNotification(checkRunPayload());

    expect(mockEnqueuePrReviewNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        event: expect.objectContaining({ kind: 'ci_failure' }),
      }),
    );
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
  });

  it('resolves a fork-based pull request from the failed check head SHA', async () => {
    mockListPullRequestsAssociatedWithCommit.mockResolvedValue({
      data: [
        { number: 84, state: 'open', head: { sha: 'abc123' } },
        { number: 85, state: 'closed', head: { sha: 'abc123' } },
        { number: 86, state: 'open', head: { sha: 'newer-sha' } },
      ],
    });

    await queuePrCiFailureNotification(
      checkRunPayload({ pullRequestNumbers: [] }),
    );

    expect(mockListPullRequestsAssociatedWithCommit).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      commit_sha: 'abc123',
    });
    expect(mockEnqueuePrReviewNotification).toHaveBeenCalledTimes(1);
    expect(mockEnqueuePrReviewNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 84,
        event: expect.objectContaining({ reviewHeadSha: 'abc123' }),
      }),
    );
  });

  it('does not resolve pull requests for a successful check', async () => {
    await queuePrCiFailureNotification(
      checkRunPayload({ conclusion: 'success', pullRequestNumbers: [] }),
    );

    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();
  });
});

// pnpm --filter @roomote/api test src/handlers/github/__tests__/notifyPrReviewActivity.lifecycle.test.ts

const {
  mockCompleteGithubPrReviewCheckFromSummary,
  mockEnqueuePrReviewNotification,
  mockMarkRoomotePullRequestReadyAfterCleanReview,
  mockStartPrReviewNotificationCycle,
} = vi.hoisted(() => ({
  mockCompleteGithubPrReviewCheckFromSummary: vi
    .fn()
    .mockResolvedValue(undefined),
  mockEnqueuePrReviewNotification: vi
    .fn()
    .mockResolvedValue({ notifiedTaskCount: 1 }),
  mockMarkRoomotePullRequestReadyAfterCleanReview: vi
    .fn()
    .mockResolvedValue('marked_ready'),
  mockStartPrReviewNotificationCycle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      R_GITHUB_APP_SLUG: 'roomote',
      R_GITHUB_ADDITIONAL_APP_SLUGS: 'roomote-community',
    },
  };
});

vi.mock('@roomote/sdk/server', () => ({
  completeGithubPrReviewCheckFromSummary:
    mockCompleteGithubPrReviewCheckFromSummary,
  enqueuePrReviewNotification: mockEnqueuePrReviewNotification,
  markRoomotePullRequestReadyAfterCleanReview:
    mockMarkRoomotePullRequestReadyAfterCleanReview,
  startPrReviewNotificationCycle: mockStartPrReviewNotificationCycle,
}));

import { setConfiguredGitHubAppSlugCache } from '@roomote/github';

import { queuePrReviewSummaryNotification } from '../notifyPrReviewActivity';

/* oxlint-disable typescript/no-explicit-any */

const REVIEW_HEAD_SHA = '037c1c632f4f4cc6b6a52d23c59ed17d8f56e4e4';
const COMMENT_ID = 5426226987;
const CREATED_AT = '2026-08-26T13:44:18.000Z';
const COMPLETED_AT = '2026-08-26T13:48:07.000Z';

const IN_PROGRESS_BODY = [
  `<!-- roomote-review-summary sha=${REVIEW_HEAD_SHA} mode=sync version=2 phase=reviewing -->`,
  '<!-- roomote-review-status:start -->',
  'I am reviewing the updated PR head now.',
  '<!-- roomote-review-status:end -->',
  '<!-- roomote-review-checklist:start -->',
  '<!-- roomote-review-checklist:end -->',
  `<sub>Reviewing ${REVIEW_HEAD_SHA.slice(0, 7)}</sub>`,
].join('\n');

const TERMINAL_BODY = [
  `<!-- roomote-review-summary sha=${REVIEW_HEAD_SHA} mode=sync version=2 phase=reviewed -->`,
  '<!-- roomote-review-status:start -->',
  '1 issue outstanding. [See task](https://roomote.dev/task/reviewtask)',
  '<!-- roomote-review-status:end -->',
  '<!-- roomote-review-checklist:start -->',
  '- [ ] Validate image values before they satisfy the empty-message guard.',
  '<!-- roomote-review-checklist:end -->',
  `<sub>Reviewed ${REVIEW_HEAD_SHA.slice(0, 7)}</sub>`,
].join('\n');

function summaryPayload({
  body,
  updatedAt,
  previousBody,
}: {
  body: string;
  updatedAt: string;
  previousBody?: string;
}): any {
  return {
    installation: { id: 1 },
    repository: { full_name: 'RooCodeInc/Roomote' },
    issue: {
      number: 1688,
      html_url: 'https://github.com/RooCodeInc/Roomote/pull/1688',
      pull_request: {
        html_url: 'https://github.com/RooCodeInc/Roomote/pull/1688',
      },
    },
    comment: {
      id: COMMENT_ID,
      body,
      created_at: CREATED_AT,
      updated_at: updatedAt,
      html_url: `https://github.com/RooCodeInc/Roomote/pull/1688#issuecomment-${COMMENT_ID}`,
      user: { login: 'roomote-community[bot]' },
    },
    ...(previousBody
      ? {
          changes: {
            body: { from: previousBody },
          },
        }
      : {}),
  };
}

describe('PR review-summary lifecycle replay', () => {
  beforeEach(() => {
    setConfiguredGitHubAppSlugCache({
      value: 'roomote',
      expiresAt: Date.now() + 60_000,
    });
    mockCompleteGithubPrReviewCheckFromSummary.mockClear();
    mockEnqueuePrReviewNotification.mockClear();
    mockMarkRoomotePullRequestReadyAfterCleanReview.mockClear();
    mockStartPrReviewNotificationCycle.mockClear();
  });

  afterEach(() => {
    setConfiguredGitHubAppSlugCache(null);
  });

  it('opens the in-progress cycle and enqueues only the terminal finding', async () => {
    await queuePrReviewSummaryNotification(
      summaryPayload({
        body: IN_PROGRESS_BODY,
        updatedAt: CREATED_AT,
      }),
    );

    expect(mockStartPrReviewNotificationCycle).toHaveBeenCalledOnce();
    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();

    await queuePrReviewSummaryNotification(
      summaryPayload({
        body: TERMINAL_BODY,
        previousBody: IN_PROGRESS_BODY,
        updatedAt: COMPLETED_AT,
      }),
    );

    expect(mockEnqueuePrReviewNotification).toHaveBeenCalledOnce();
    expect(
      mockMarkRoomotePullRequestReadyAfterCleanReview,
    ).not.toHaveBeenCalled();
    expect(mockEnqueuePrReviewNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'RooCodeInc/Roomote',
        prNumber: 1688,
        event: expect.objectContaining({
          kind: 'review_summary',
          summary: '1 issue outstanding.',
          reviewHeadSha: REVIEW_HEAD_SHA,
          roomoteAuthored: true,
        }),
      }),
    );
  });

  it('promotes only after a durable clean terminal summary is recorded', async () => {
    const cleanBody = TERMINAL_BODY.replace(
      '1 issue outstanding.',
      'No code issues found.',
    ).replace(
      '- [ ] Validate image values before they satisfy the empty-message guard.',
      '',
    );

    await queuePrReviewSummaryNotification(
      summaryPayload({
        body: cleanBody,
        previousBody: IN_PROGRESS_BODY,
        updatedAt: COMPLETED_AT,
      }),
    );

    expect(mockEnqueuePrReviewNotification).toHaveBeenCalledOnce();
    expect(
      mockMarkRoomotePullRequestReadyAfterCleanReview,
    ).toHaveBeenCalledWith({
      installationId: 1,
      repository: 'RooCodeInc/Roomote',
      prNumber: 1688,
      reviewHeadSha: REVIEW_HEAD_SHA,
      reviewResult: expect.objectContaining({
        outcome: 'clean',
        findingCount: null,
      }),
    });
    expect(
      mockEnqueuePrReviewNotification.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockMarkRoomotePullRequestReadyAfterCleanReview.mock
        .invocationCallOrder[0]!,
    );
  });

  it('does not promote a stale clean summary', async () => {
    mockEnqueuePrReviewNotification.mockResolvedValueOnce({
      notifiedTaskCount: 0,
      reason: 'stale_review_cycle',
    });
    const cleanBody = TERMINAL_BODY.replace(
      '1 issue outstanding.',
      'No code issues found.',
    ).replace(
      '- [ ] Validate image values before they satisfy the empty-message guard.',
      '',
    );

    await queuePrReviewSummaryNotification(
      summaryPayload({
        body: cleanBody,
        previousBody: IN_PROGRESS_BODY,
        updatedAt: COMPLETED_AT,
      }),
    );

    expect(
      mockMarkRoomotePullRequestReadyAfterCleanReview,
    ).not.toHaveBeenCalled();
  });
});

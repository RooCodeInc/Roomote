// pnpm --filter @roomote/api test src/handlers/github/__tests__/notifyPrReviewActivity.test.ts

const { mockEnqueuePrReviewNotification, mockStartPrReviewNotificationCycle } =
  vi.hoisted(() => ({
    mockEnqueuePrReviewNotification: vi.fn().mockResolvedValue({
      notifiedTaskCount: 1,
    }),
    mockStartPrReviewNotificationCycle: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      R_GITHUB_APP_SLUG: 'roomote',
    },
  };
});

vi.mock('@roomote/sdk/server', () => ({
  enqueuePrReviewNotification: mockEnqueuePrReviewNotification,
  startPrReviewNotificationCycle: mockStartPrReviewNotificationCycle,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  REVIEW_SUMMARY_MARKER: '<!-- roomote-review-summary',
  REVIEW_STATUS_START_MARKER: '<!-- roomote-review-status:start -->',
  REVIEW_STATUS_END_MARKER: '<!-- roomote-review-status:end -->',
  getMarkedSection: ({
    content,
    startMarker,
    endMarker,
  }: {
    content: string;
    startMarker: string;
    endMarker: string;
  }) => {
    const startIndex = content.indexOf(startMarker);

    if (startIndex === -1) {
      return undefined;
    }

    const afterStart = startIndex + startMarker.length;
    const endIndex = content.indexOf(endMarker, afterStart);

    if (endIndex === -1) {
      return undefined;
    }

    return content.slice(afterStart, endIndex).trim();
  },
  isReviewInProgressStatusLine: (line: string) =>
    /^(Self-reviewing the PR(?: with fresh eyes)? now\.|Reviewing the PR now\.|Re-reviewing new commits now\.)/i.test(
      line.trim(),
    ),
}));

import { setConfiguredGitHubAppSlugCache } from '@roomote/github';

import {
  buildPrReviewActivityNotificationInput,
  buildPrReviewSummaryNotification,
  queuePrReviewActivityNotification,
  queuePrReviewSummaryNotification,
} from '../notifyPrReviewActivity';

/* oxlint-disable typescript/no-explicit-any */

const repository = { full_name: 'owner/repo' };
const pullRequest = {
  number: 42,
  html_url: 'https://github.com/owner/repo/pull/42',
};
const reviewHeadSha = 'f0c89ce4';
const createdAt = '2026-08-10T19:30:00.000Z';
const observedAt = Date.parse(createdAt);

function reviewPayload(review: {
  body?: string | null;
  state?: string;
  login?: string | null;
}): any {
  return {
    repository,
    pull_request: pullRequest,
    review: {
      id: 1000,
      body: review.body ?? null,
      commit_id: reviewHeadSha,
      state: review.state ?? 'approved',
      submitted_at: createdAt,
      html_url: 'https://github.com/owner/repo/pull/42#pullrequestreview-1000',
      user: review.login === null ? null : { login: review.login ?? 'alice' },
    },
  };
}

function reviewCommentPayload(comment: {
  body?: string;
  login?: string | null;
  inReplyToId?: number;
}): any {
  return {
    repository,
    pull_request: pullRequest,
    comment: {
      id: 2000,
      body: comment.body ?? 'Looks off to me',
      commit_id: reviewHeadSha,
      created_at: createdAt,
      in_reply_to_id: comment.inReplyToId,
      pull_request_review_id: 1000,
      html_url: 'https://github.com/owner/repo/pull/42#discussion_r2000',
      user: comment.login === null ? null : { login: comment.login ?? 'alice' },
    },
  };
}

function issueCommentPayload(
  comment: {
    body?: string;
    login?: string | null;
    isPr?: boolean;
  } = {},
): any {
  return {
    repository,
    issue: {
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      pull_request:
        comment.isPr === false
          ? undefined
          : { html_url: 'https://github.com/owner/repo/pull/42' },
    },
    comment: {
      id: 3000,
      body: comment.body ?? 'Could we simplify this?',
      created_at: createdAt,
      html_url: 'https://github.com/owner/repo/pull/42#issuecomment-3000',
      user: comment.login === null ? null : { login: comment.login ?? 'alice' },
    },
  };
}

describe('buildPrReviewActivityNotificationInput', () => {
  it('builds a review event for a submitted review', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewPayload({ state: 'changes_requested', body: 'Please fix' }),
      ),
    ).toEqual({
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      sourceControlProvider: 'github',
      event: {
        kind: 'review',
        providerEventId: 'github-review:1000',
        authorLogin: 'alice',
        reviewHeadSha,
        batchId: 'github-review:1000',
        reviewState: 'changes_requested',
        url: 'https://github.com/owner/repo/pull/42#pullrequestreview-1000',
        observedAt,
      },
    });
  });

  it('skips reviews that mention the bot', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewPayload({ body: '@roomote please fix this' }),
      ),
    ).toBeNull();
  });

  it('skips synthetic empty commented reviews that wrap inline comments', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewPayload({ state: 'commented', body: null }),
      ),
    ).toBeNull();
  });

  it('keeps commented reviews that carry a summary body', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewPayload({ state: 'commented', body: 'Overall looks fine' }),
      ),
    ).toMatchObject({
      event: { kind: 'review', reviewState: 'commented' },
    });
  });

  it('skips reviews without an author', () => {
    expect(
      buildPrReviewActivityNotificationInput(reviewPayload({ login: null })),
    ).toBeNull();
  });

  it('builds a review_comment event for a new review thread', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewCommentPayload({ login: 'bob' }),
      ),
    ).toEqual({
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      sourceControlProvider: 'github',
      event: {
        kind: 'review_comment',
        providerEventId: 'github-review-comment:2000',
        authorLogin: 'bob',
        reviewHeadSha,
        batchId: 'github-review:1000',
        url: 'https://github.com/owner/repo/pull/42#discussion_r2000',
        observedAt,
      },
    });
  });

  it('builds an issue_comment event for a human top-level PR comment', () => {
    expect(
      buildPrReviewActivityNotificationInput(issueCommentPayload()),
    ).toEqual({
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      sourceControlProvider: 'github',
      event: {
        kind: 'issue_comment',
        providerEventId: 'github-issue-comment:3000',
        authorLogin: 'alice',
        url: 'https://github.com/owner/repo/pull/42#issuecomment-3000',
        observedAt,
      },
    });
  });

  it('skips top-level PR comments handled by the mention flow', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        issueCommentPayload({ body: '@roomote please fix this' }),
      ),
    ).toBeNull();
  });

  it('skips Roomote-authored and non-PR issue comments', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        issueCommentPayload({ login: 'roomote[bot]' }),
      ),
    ).toBeNull();
    expect(
      buildPrReviewActivityNotificationInput(
        issueCommentPayload({ isPr: false }),
      ),
    ).toBeNull();
  });

  it('keeps new review threads authored by Roomote (e.g. PR review findings)', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewCommentPayload({ login: 'roomote[bot]' }),
      ),
    ).toMatchObject({
      event: {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
      },
    });
  });

  it('skips Roomote-authored replies to existing review threads', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewCommentPayload({ login: 'roomote[bot]', inReplyToId: 99 }),
      ),
    ).toBeNull();
  });

  it('keeps human replies to existing review threads', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewCommentPayload({ login: 'carol', inReplyToId: 99 }),
      ),
    ).toMatchObject({
      event: { kind: 'review_comment', authorLogin: 'carol' },
    });
  });

  it('skips review comments that mention the bot', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewCommentPayload({ body: '@roomote fix this' }),
      ),
    ).toBeNull();
  });
});

describe('queuePrReviewActivityNotification', () => {
  beforeEach(() => {
    mockEnqueuePrReviewNotification.mockClear();
    mockEnqueuePrReviewNotification.mockResolvedValue({
      notifiedTaskCount: 1,
    });
  });

  it('enqueues qualifying events', () => {
    queuePrReviewActivityNotification(reviewPayload({ state: 'approved' }));

    expect(mockEnqueuePrReviewNotification).toHaveBeenCalledWith({
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      sourceControlProvider: 'github',
      event: {
        kind: 'review',
        providerEventId: 'github-review:1000',
        authorLogin: 'alice',
        reviewHeadSha,
        batchId: 'github-review:1000',
        reviewState: 'approved',
        url: 'https://github.com/owner/repo/pull/42#pullrequestreview-1000',
        observedAt,
      },
    });
  });

  it('does nothing for filtered events', () => {
    queuePrReviewActivityNotification(
      reviewPayload({ body: '@roomote take a look' }),
    );

    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();
  });

  it('passes Roomote-authored activity to the shared coordinator', async () => {
    queuePrReviewActivityNotification(
      reviewCommentPayload({ login: 'roomote[bot]' }),
    );

    await vi.waitFor(() =>
      expect(mockEnqueuePrReviewNotification).toHaveBeenCalled(),
    );
  });

  it('propagates persistence failures so the webhook can retry', async () => {
    mockEnqueuePrReviewNotification.mockRejectedValue(new Error('redis down'));

    await expect(
      queuePrReviewActivityNotification(reviewPayload({ state: 'approved' })),
    ).rejects.toThrow('redis down');
  });
});

const TERMINAL_SUMMARY_BODY = [
  '<!-- roomote-review-summary sha=f0c89ce4 mode=initial -->',
  '<!-- roomote-review-status:start -->',
  '1 minor doc note; no blocking issues. [See task](https://roomote.dev/task/x)',
  '<!-- roomote-review-status:end -->',
  '<!-- roomote-review-checklist:start -->',
  '- [ ] Update the doc comment',
  '<!-- roomote-review-checklist:end -->',
].join('\n');

const IN_PROGRESS_SUMMARY_BODY = [
  '<!-- roomote-review-summary sha=f0c89ce4 mode=initial -->',
  '<!-- roomote-review-status:start -->',
  'Reviewing the PR now. [See task](https://roomote.dev/task/x)',
  '<!-- roomote-review-status:end -->',
].join('\n');

const ALL_ADDRESSED_SUMMARY_BODY = [
  '<!-- roomote-review-summary sha=abcdef01 mode=initial -->',
  '<!-- roomote-review-status:start -->',
  '**All 1 issue addressed.** [See task](https://roomote.dev/task/x)',
  '<!-- roomote-review-status:end -->',
  '<!-- roomote-review-checklist:start -->',
  '- [x] Update the doc comment',
  '<!-- roomote-review-checklist:end -->',
].join('\n');

const CHECKLIST_ONLY_EDIT_BODY = [
  '<!-- roomote-review-summary sha=f0c89ce4 mode=initial -->',
  '<!-- roomote-review-status:start -->',
  '1 minor doc note; no blocking issues. [See task](https://roomote.dev/task/x)',
  '<!-- roomote-review-status:end -->',
  '<!-- roomote-review-checklist:start -->',
  '- [x] Update the doc comment',
  '<!-- roomote-review-checklist:end -->',
].join('\n');

function summaryPayload({
  body = TERMINAL_SUMMARY_BODY,
  login = 'roomote[bot]',
  commentId = 99,
  isPr = true,
  previousBody,
  updatedAt = createdAt,
}: {
  body?: string;
  login?: string | null;
  commentId?: number;
  isPr?: boolean;
  /** When set, models an issue_comment.edited payload with changes.body.from. */
  previousBody?: string | null;
  updatedAt?: string;
} = {}): any {
  return {
    repository,
    issue: {
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      pull_request: isPr
        ? { html_url: 'https://github.com/owner/repo/pull/42' }
        : undefined,
    },
    comment: {
      id: commentId,
      body,
      created_at: createdAt,
      updated_at: updatedAt,
      html_url: `https://github.com/owner/repo/pull/42#issuecomment-${commentId}`,
      user: login === null ? null : { login },
    },
    ...(previousBody !== undefined
      ? {
          changes: {
            body:
              previousBody === null
                ? {}
                : {
                    from: previousBody,
                  },
          },
        }
      : {}),
  };
}

describe('buildPrReviewSummaryNotification', () => {
  it('builds a review_summary event from a terminal Roomote summary comment on create', () => {
    const notification = buildPrReviewSummaryNotification(summaryPayload());

    expect(notification?.input).toEqual({
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      sourceControlProvider: 'github',
      event: {
        kind: 'review_summary',
        providerEventId: 'github-review-summary:99:2026-08-10T19:30:00.000Z',
        authorLogin: 'roomote[bot]',
        reviewHeadSha,
        summary: '1 minor doc note; no blocking issues.',
        url: 'https://github.com/owner/repo/pull/42#issuecomment-99',
        observedAt,
        roomoteAuthored: true,
      },
    });
  });

  it('notifies when an edit flips in-progress status to a terminal review result', () => {
    const notification = buildPrReviewSummaryNotification(
      summaryPayload({
        body: TERMINAL_SUMMARY_BODY,
        previousBody: IN_PROGRESS_SUMMARY_BODY,
      }),
    );

    expect(notification?.input.event).toMatchObject({
      kind: 'review_summary',
      summary: '1 minor doc note; no blocking issues.',
      roomoteAuthored: true,
    });
  });

  it('skips fixer terminal-to-terminal rewrites of the pinned summary', () => {
    expect(
      buildPrReviewSummaryNotification(
        summaryPayload({
          body: ALL_ADDRESSED_SUMMARY_BODY,
          previousBody: TERMINAL_SUMMARY_BODY,
        }),
      ),
    ).toBeNull();
  });

  it('skips edited summaries that only change the checklist', () => {
    expect(
      buildPrReviewSummaryNotification(
        summaryPayload({
          body: CHECKLIST_ONLY_EDIT_BODY,
          previousBody: TERMINAL_SUMMARY_BODY,
        }),
      ),
    ).toBeNull();
  });

  it('skips edited events without a previous body', () => {
    expect(
      buildPrReviewSummaryNotification(
        summaryPayload({
          body: TERMINAL_SUMMARY_BODY,
          previousBody: null,
        }),
      ),
    ).toBeNull();
  });

  it('skips in-progress summary comments', () => {
    expect(
      buildPrReviewSummaryNotification(
        summaryPayload({ body: IN_PROGRESS_SUMMARY_BODY }),
      ),
    ).toBeNull();
  });

  it('skips comments without the review-summary marker', () => {
    expect(
      buildPrReviewSummaryNotification(
        summaryPayload({ body: 'Just a regular bot comment' }),
      ),
    ).toBeNull();
  });

  it('skips summary-shaped comments from non-Roomote authors', () => {
    expect(
      buildPrReviewSummaryNotification(summaryPayload({ login: 'alice' })),
    ).toBeNull();
  });

  it('skips non-PR issue comments', () => {
    expect(
      buildPrReviewSummaryNotification(summaryPayload({ isPr: false })),
    ).toBeNull();
  });
});

// Regression: a deployment whose GitHub App was created through the /setup
// flow keeps its slug in the encrypted environment_variables table, so the
// process env falls back to `roomote` while the bot posts under the
// configured slug (e.g. acme[bot]). The identity helpers must honor the
// resolved slug or every review-summary notification is silently dropped.
describe('with a database-configured app slug', () => {
  beforeEach(() => {
    setConfiguredGitHubAppSlugCache({
      value: 'acme',
      expiresAt: Date.now() + 60_000,
    });
  });

  afterEach(() => {
    setConfiguredGitHubAppSlugCache(null);
  });

  it('builds a review_summary event for the configured bot login', () => {
    const notification = buildPrReviewSummaryNotification(
      summaryPayload({ login: 'acme[bot]' }),
    );

    expect(notification?.input.event).toMatchObject({
      kind: 'review_summary',
      authorLogin: 'acme[bot]',
      roomoteAuthored: true,
    });
  });

  it('still skips summary-shaped comments from unrelated bots', () => {
    expect(
      buildPrReviewSummaryNotification(
        summaryPayload({ login: 'othermote[bot]' }),
      ),
    ).toBeNull();
  });

  it('marks new review threads from the configured bot as roomote-authored', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewCommentPayload({ login: 'acme[bot]' }),
      ),
    ).toMatchObject({
      event: {
        kind: 'review_comment',
        authorLogin: 'acme[bot]',
        roomoteAuthored: true,
      },
    });
  });

  it('skips replies to existing review threads from the configured bot', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewCommentPayload({
          login: 'acme[bot]',
          inReplyToId: 99,
        }),
      ),
    ).toBeNull();
  });

  it('skips review comments that mention the configured slug', () => {
    expect(
      buildPrReviewActivityNotificationInput(
        reviewCommentPayload({ body: '@acme fix this' }),
      ),
    ).toBeNull();
  });
});

describe('queuePrReviewSummaryNotification', () => {
  beforeEach(() => {
    mockEnqueuePrReviewNotification.mockClear();
    mockEnqueuePrReviewNotification.mockResolvedValue({ notifiedTaskCount: 1 });
    mockStartPrReviewNotificationCycle.mockClear();
    mockStartPrReviewNotificationCycle.mockResolvedValue(undefined);
  });

  it('opens an explicit cycle when the Roomote summary enters in-progress state', async () => {
    queuePrReviewSummaryNotification(
      summaryPayload({ body: IN_PROGRESS_SUMMARY_BODY }),
    );

    await vi.waitFor(() =>
      expect(mockStartPrReviewNotificationCycle).toHaveBeenCalledWith({
        repository: 'owner/repo',
        prNumber: 42,
        reviewHeadSha,
        cycleId: `github-summary:99:${createdAt}`,
        observedAt,
      }),
    );
    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();
  });

  it('enqueues the terminal summary through the shared coordinator', async () => {
    queuePrReviewSummaryNotification(
      summaryPayload({
        body: TERMINAL_SUMMARY_BODY,
        previousBody: IN_PROGRESS_SUMMARY_BODY,
      }),
    );

    await vi.waitFor(() =>
      expect(mockEnqueuePrReviewNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            kind: 'review_summary',
            reviewHeadSha,
            observedAt,
          }),
        }),
      ),
    );
  });

  it('opens a distinct cycle when the same SHA is reviewed again', async () => {
    const nextUpdatedAt = '2026-08-10T20:30:00.000Z';

    await queuePrReviewSummaryNotification(
      summaryPayload({ body: IN_PROGRESS_SUMMARY_BODY }),
    );
    await queuePrReviewSummaryNotification(
      summaryPayload({
        body: IN_PROGRESS_SUMMARY_BODY,
        previousBody: TERMINAL_SUMMARY_BODY,
        updatedAt: nextUpdatedAt,
      }),
    );

    expect(mockStartPrReviewNotificationCycle).toHaveBeenNthCalledWith(1, {
      repository: 'owner/repo',
      prNumber: 42,
      reviewHeadSha,
      cycleId: `github-summary:99:${createdAt}`,
      observedAt,
    });
    expect(mockStartPrReviewNotificationCycle).toHaveBeenNthCalledWith(2, {
      repository: 'owner/repo',
      prNumber: 42,
      reviewHeadSha,
      cycleId: `github-summary:99:${nextUpdatedAt}`,
      observedAt: Date.parse(nextUpdatedAt),
    });
  });

  it('does not reopen a cycle for an in-progress to in-progress edit', () => {
    queuePrReviewSummaryNotification(
      summaryPayload({
        body: IN_PROGRESS_SUMMARY_BODY,
        previousBody: IN_PROGRESS_SUMMARY_BODY,
      }),
    );

    expect(mockStartPrReviewNotificationCycle).not.toHaveBeenCalled();
  });

  it('does nothing for non-summary comments', () => {
    queuePrReviewSummaryNotification(
      summaryPayload({ body: 'Just a regular comment' }),
    );

    expect(mockStartPrReviewNotificationCycle).not.toHaveBeenCalled();
    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();
  });
});

// pnpm --filter @roomote/api test src/handlers/github/__tests__/notifyPrReviewActivity.test.ts

const {
  mockEnqueuePrReviewNotification,
  mockRedisGet,
  mockRedisSet,
  mockRedisDel,
  mockRedisEval,
} = vi.hoisted(() => ({
  mockEnqueuePrReviewNotification: vi.fn().mockResolvedValue({
    notifiedTaskCount: 1,
  }),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockRedisEval: vi.fn(),
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
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    eval: (...args: unknown[]) => mockRedisEval(...args),
  }),
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

/* eslint-disable @typescript-eslint/no-explicit-any */

const repository = { full_name: 'owner/repo' };
const pullRequest = {
  number: 42,
  html_url: 'https://github.com/owner/repo/pull/42',
};
const reviewHeadSha = 'f0c89ce4';

function reviewPayload(review: {
  body?: string | null;
  state?: string;
  login?: string | null;
}): any {
  return {
    repository,
    pull_request: pullRequest,
    review: {
      body: review.body ?? null,
      commit_id: reviewHeadSha,
      state: review.state ?? 'approved',
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
      body: comment.body ?? 'Looks off to me',
      commit_id: reviewHeadSha,
      in_reply_to_id: comment.inReplyToId,
      html_url: 'https://github.com/owner/repo/pull/42#discussion_r2000',
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
        authorLogin: 'alice',
        reviewHeadSha,
        reviewState: 'changes_requested',
        url: 'https://github.com/owner/repo/pull/42#pullrequestreview-1000',
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
        authorLogin: 'bob',
        reviewHeadSha,
        url: 'https://github.com/owner/repo/pull/42#discussion_r2000',
      },
    });
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
    mockRedisGet.mockReset();
    mockRedisGet.mockResolvedValue(null);
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
        authorLogin: 'alice',
        reviewHeadSha,
        reviewState: 'approved',
        url: 'https://github.com/owner/repo/pull/42#pullrequestreview-1000',
      },
    });
  });

  it('does nothing for filtered events', () => {
    queuePrReviewActivityNotification(
      reviewPayload({ body: '@roomote take a look' }),
    );

    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();
  });

  it('skips Roomote-authored activity after the same review pass completed', async () => {
    mockRedisGet.mockResolvedValue('1');

    queuePrReviewActivityNotification(
      reviewCommentPayload({ login: 'roomote[bot]' }),
    );

    await vi.waitFor(() => expect(mockRedisGet).toHaveBeenCalled());
    expect(mockRedisGet).toHaveBeenCalledWith(
      expect.stringContaining(
        `review-completed:owner%2Frepo#42:${reviewHeadSha}`,
      ),
    );
    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();
  });

  it('keeps Roomote-authored activity when the review pass has no completion marker', async () => {
    queuePrReviewActivityNotification(
      reviewCommentPayload({ login: 'roomote[bot]' }),
    );

    await vi.waitFor(() =>
      expect(mockEnqueuePrReviewNotification).toHaveBeenCalled(),
    );
  });

  it('keeps human activity after a Roomote review pass completed', async () => {
    mockRedisGet.mockResolvedValue('1');

    queuePrReviewActivityNotification(reviewCommentPayload({ login: 'alice' }));

    await vi.waitFor(() =>
      expect(mockEnqueuePrReviewNotification).toHaveBeenCalled(),
    );
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it('swallows enqueue failures', async () => {
    mockEnqueuePrReviewNotification.mockRejectedValue(new Error('redis down'));

    expect(() =>
      queuePrReviewActivityNotification(reviewPayload({ state: 'approved' })),
    ).not.toThrow();

    await vi.waitFor(() =>
      expect(mockEnqueuePrReviewNotification).toHaveBeenCalled(),
    );
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
}: {
  body?: string;
  login?: string | null;
  commentId?: number;
  isPr?: boolean;
  /** When set, models an issue_comment.edited payload with changes.body.from. */
  previousBody?: string | null;
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
        authorLogin: 'roomote[bot]',
        reviewHeadSha,
        summary: '1 minor doc note; no blocking issues.',
        url: 'https://github.com/owner/repo/pull/42#issuecomment-99',
        roomoteAuthored: true,
      },
    });
    expect(notification?.dedupKey).toContain('99');
    expect(notification?.dedupKey).toContain('f0c89ce4');
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
    mockRedisSet.mockReset();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockReset();
    mockRedisDel.mockResolvedValue(1);
    mockRedisEval.mockReset();
    mockRedisEval.mockResolvedValue(1);
  });

  it('enqueues the summary notification once per review pass', async () => {
    queuePrReviewSummaryNotification(summaryPayload());

    await vi.waitFor(() =>
      expect(mockEnqueuePrReviewNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({ kind: 'review_summary' }),
        }),
      ),
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('summary-notified'),
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining(
        `review-completed:owner%2Frepo#42:${reviewHeadSha}`,
      ),
      expect.stringContaining('summary-notified'),
      'EX',
      expect.any(Number),
    );
    const completedMarkerCall = mockRedisSet.mock.calls.find(([key]) =>
      String(key).includes('review-completed'),
    );
    expect(completedMarkerCall).toBeDefined();
    expect(completedMarkerCall?.[0]).toBe(
      `pr-review-notification:review-completed:owner%2Frepo#42:${reviewHeadSha}`,
    );
    expect(
      mockRedisSet.mock.invocationCallOrder.find(
        (_, index) => mockRedisSet.mock.calls[index] === completedMarkerCall,
      ),
    ).toBeLessThan(
      mockEnqueuePrReviewNotification.mock.invocationCallOrder[0]!,
    );
    expect(mockRedisDel).not.toHaveBeenCalled();
    expect(mockRedisEval).not.toHaveBeenCalled();
  });

  it('suppresses Roomote inline activity while the summary enqueue is still pending', async () => {
    let resolveSummaryEnqueue!: (value: { notifiedTaskCount: number }) => void;
    mockEnqueuePrReviewNotification.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSummaryEnqueue = resolve;
        }),
    );

    queuePrReviewSummaryNotification(summaryPayload());

    await vi.waitFor(() =>
      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('review-completed'),
        expect.stringContaining('summary-notified'),
        'EX',
        expect.any(Number),
      ),
    );
    mockRedisGet.mockResolvedValue('summary-notified');

    queuePrReviewActivityNotification(
      reviewCommentPayload({ login: 'roomote[bot]' }),
    );

    await vi.waitFor(() => expect(mockRedisGet).toHaveBeenCalled());
    expect(mockEnqueuePrReviewNotification).toHaveBeenCalledTimes(1);

    resolveSummaryEnqueue({ notifiedTaskCount: 1 });
  });

  it('releases the dedup claim when the notification was a no-op', async () => {
    mockEnqueuePrReviewNotification.mockResolvedValue({
      notifiedTaskCount: 0,
      reason: 'no_thread_context',
    });

    queuePrReviewSummaryNotification(summaryPayload());

    await vi.waitFor(() =>
      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('summary-notified'),
      ),
    );
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      expect.stringContaining('review-completed'),
      expect.stringContaining('summary-notified'),
    );
  });

  it('releases the dedup claim when enqueueing fails', async () => {
    mockEnqueuePrReviewNotification.mockRejectedValue(new Error('redis down'));

    queuePrReviewSummaryNotification(summaryPayload());

    await vi.waitFor(() =>
      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('summary-notified'),
      ),
    );
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      expect.stringContaining('review-completed'),
      expect.stringContaining('summary-notified'),
    );
  });

  it('does not re-enqueue when the dedup key is already claimed', async () => {
    mockRedisSet.mockResolvedValue(null);

    queuePrReviewSummaryNotification(summaryPayload());

    await vi.waitFor(() => expect(mockRedisSet).toHaveBeenCalled());
    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();
  });

  it('does nothing for non-summary comments', () => {
    queuePrReviewSummaryNotification(
      summaryPayload({ body: 'Just a regular comment' }),
    );

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockEnqueuePrReviewNotification).not.toHaveBeenCalled();
  });
});

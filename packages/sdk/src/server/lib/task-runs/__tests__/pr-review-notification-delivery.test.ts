const {
  mockGenerateObject,
  mockReadSourceControlPullRequest,
  mockResolveRoute,
  mockFormatMessage,
  mockRecordTaskMessageEnvelope,
  mockTrackSlackBotReply,
  mockSetLatestSlackBotReply,
  mockCreateTaskRunGitHubToken,
  mockPullsGet,
  mockListCheckRunsForRef,
  mockGetCombinedStatusForRef,
  mockIsRoomoteGitHubLogin,
  mockResolveConfiguredGitHubAppSlug,
  mockGetGitHubRateLimitRetryAfterMs,
} = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
  mockReadSourceControlPullRequest: vi.fn(),
  mockResolveRoute: vi.fn(),
  mockFormatMessage: vi.fn(),
  mockRecordTaskMessageEnvelope: vi.fn(),
  mockTrackSlackBotReply: vi.fn(),
  mockSetLatestSlackBotReply: vi.fn(),
  mockCreateTaskRunGitHubToken: vi.fn(),
  mockPullsGet: vi.fn(),
  mockListCheckRunsForRef: vi.fn(),
  mockGetCombinedStatusForRef: vi.fn(),
  mockIsRoomoteGitHubLogin: vi.fn((login: string) => login === 'roomote[bot]'),
  mockResolveConfiguredGitHubAppSlug: vi.fn(),
  mockGetGitHubRateLimitRetryAfterMs: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/non-task-provider-usage', () => ({
  generateTrackedNonTaskObject: mockGenerateObject,
  NON_TASK_INFERENCE_SURFACES: {
    prReviewNotificationTriage: 'pr_review_notification_triage',
  },
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
    const start = content.indexOf(startMarker);
    const end = content.indexOf(endMarker);

    if (start === -1 || end === -1) {
      return undefined;
    }

    return content.slice(start + startMarker.length, end);
  },
  isReviewInProgressStatusLine: (line: string) =>
    /^(Self-reviewing|Reviewing|Re-reviewing)/i.test(line.trim()),
}));

vi.mock('../../pull-requests/source-control-pull-request-reads', () => ({
  readSourceControlPullRequestForTaskRun: mockReadSourceControlPullRequest,
}));

vi.mock('../pr-review-notification', async () => {
  const actual = await vi.importActual<
    typeof import('../pr-review-notification')
  >('../pr-review-notification');

  return {
    ...actual,
    resolvePrReviewNotificationRoute: mockResolveRoute,
    formatPrReviewActivityMessage: mockFormatMessage,
  };
});

vi.mock('../record-task-message-envelope', () => ({
  recordTaskMessageEnvelope: mockRecordTaskMessageEnvelope,
}));

vi.mock('@roomote/slack', () => ({
  trackSlackBotReply: mockTrackSlackBotReply,
  setLatestSlackBotReply: mockSetLatestSlackBotReply,
}));

vi.mock('@roomote/github', () => ({
  Schemas: {
    isRoomoteGitHubLogin: (login: string) => mockIsRoomoteGitHubLogin(login),
  },
  resolveConfiguredGitHubAppSlug: () => mockResolveConfiguredGitHubAppSlug(),
  createTaskRunGitHubToken: (...args: unknown[]) =>
    mockCreateTaskRunGitHubToken(...args),
  getOctokit: () => ({
    rest: {
      pulls: {
        get: (...args: unknown[]) => mockPullsGet(...args),
      },
      checks: {
        listForRef: (...args: unknown[]) => mockListCheckRunsForRef(...args),
      },
      repos: {
        getCombinedStatusForRef: (...args: unknown[]) =>
          mockGetCombinedStatusForRef(...args),
      },
    },
  }),
  getGitHubRateLimitRetryAfterMs: (...args: unknown[]) =>
    mockGetGitHubRateLimitRetryAfterMs(...args),
  isGitHubUnauthorizedError: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    Number(error.status) === 401,
  withTaskRunGitHubTokenRetry: async (
    taskRun: unknown,
    operation: (token: string) => Promise<unknown>,
    runtimeOptions?: unknown,
  ) => operation(await mockCreateTaskRunGitHubToken(taskRun, runtimeOptions)),
}));

import type { TaskRun } from '@roomote/db/server';
import type { PrReviewActivityEvent } from '../pr-review-notification';

import {
  clearPrReviewTriageDecisionCache,
  collectCiChecks,
  createPrReviewNotificationTelemetry,
  gatherPrReviewTriageContext,
  PrReviewNotificationRateLimitError,
  preparePrReviewNotificationDelivery,
  recordPrReviewNotificationDeliveryBestEffort,
  triagePrReviewActivity,
} from '../pr-review-notification-delivery';

const request = {
  taskId: 'task-1',
  repository: 'owner/repo',
  prNumber: 42,
  prUrl: 'https://github.com/owner/repo/pull/42',
  deferrals: 0,
};

const taskRun = { id: 1, payload: {} } as unknown as TaskRun;

const events: PrReviewActivityEvent[] = [
  { kind: 'review', authorLogin: 'alice', reviewState: 'approved' },
  { kind: 'review_comment', authorLogin: 'bob' },
  {
    kind: 'review_summary',
    authorLogin: 'roomote[bot]',
    summary: '1 issue to consider. The change correctly follows the pattern',
    url: 'https://github.com/owner/repo/pull/42#issuecomment-7',
    roomoteAuthored: true,
  },
];

beforeEach(() => {
  clearPrReviewTriageDecisionCache();
});

const eventsWithoutSelfReview: PrReviewActivityEvent[] = events.slice(0, 2);

beforeEach(() => {
  mockIsRoomoteGitHubLogin.mockImplementation(
    (login: string) => login === 'roomote[bot]',
  );
  mockResolveConfiguredGitHubAppSlug.mockResolvedValue('roomote');
});

function mockGreenCiChecks() {
  mockCreateTaskRunGitHubToken.mockImplementation(
    async (
      _taskRun: unknown,
      runtimeOptions?: { onTokenMintRequest?: () => void },
    ) => {
      runtimeOptions?.onTokenMintRequest?.();
      return 'github-token';
    },
  );
  mockPullsGet.mockResolvedValue({
    data: { head: { sha: 'abc123' }, mergeable: true },
  });
  mockListCheckRunsForRef.mockResolvedValue({
    data: {
      check_runs: [
        { name: 'CI / Lint', status: 'completed', conclusion: 'success' },
        { name: 'CI / Tests', status: 'completed', conclusion: 'success' },
      ],
    },
  });
  // GitHub returns pending with an empty statuses list for Actions-only repos.
  mockGetCombinedStatusForRef.mockResolvedValue({
    data: { state: 'pending', statuses: [], total_count: 0 },
  });
}

describe('preparePrReviewNotificationDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockResolveRoute.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123',
      threadId: '111.222',
    });
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [
        { id: 't1', resolved: true, path: null, line: null, comments: [] },
        { id: 't2', resolved: false, path: null, line: null, comments: [] },
      ],
      issueComments: [
        {
          id: 'c1',
          author: 'roomote[bot]',
          body: '<!-- roomote-review-summary sha=abc mode=initial -->\n<!-- roomote-review-status:start -->\n**All 1 issue addressed.** [See task](https://example.com)\n<!-- roomote-review-status:end -->',
          createdAt: null,
          url: null,
        },
      ],
      warnings: [],
    });
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        summary:
          'alice approved [owner/repo#42](https://github.com/owner/repo/pull/42).',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });
    mockFormatMessage.mockReturnValue('formatted-message');
    mockGetGitHubRateLimitRetryAfterMs.mockReturnValue(null);
    mockGreenCiChecks();
  });

  it('suppresses CI failures from an outdated PR head', async () => {
    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'ci_failure',
            authorLogin: 'github-actions',
            checkName: 'CI / Tests',
            reviewHeadSha: 'old-head',
          },
        ],
      }),
    ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });

    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('propagates GitHub rate limits so durable delivery can defer', async () => {
    const rateLimitError = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
    });
    mockReadSourceControlPullRequest.mockRejectedValue(rateLimitError);
    mockGetGitHubRateLimitRetryAfterMs.mockImplementation((error: unknown) =>
      error === rateLimitError ? 900_000 : null,
    );

    await expect(
      gatherPrReviewTriageContext({
        taskRun,
        repository: request.repository,
        prNumber: request.prNumber,
        sourceControlProvider: 'github',
      }),
    ).rejects.toMatchObject({
      name: 'PrReviewNotificationRateLimitError',
      retryAfterMs: 900_000,
    });
    expect(mockPullsGet).not.toHaveBeenCalled();
  });

  it('propagates rate limits from nested live-head status reads', async () => {
    const rateLimitError = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
    });
    mockListCheckRunsForRef.mockRejectedValue(rateLimitError);
    mockGetGitHubRateLimitRetryAfterMs.mockImplementation((error: unknown) =>
      error === rateLimitError ? 900_000 : null,
    );

    await expect(
      gatherPrReviewTriageContext({
        taskRun,
        repository: request.repository,
        prNumber: request.prNumber,
        sourceControlProvider: 'github',
      }),
    ).rejects.toBeInstanceOf(PrReviewNotificationRateLimitError);
  });

  it('prepares a routed, formatted delivery from the shared SDK flow', async () => {
    const result = await preparePrReviewNotificationDelivery({
      taskRun,
      request,
      events,
    });

    expect(result).toEqual({
      post: true,
      route: {
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
      followUpQuestion: null,
      followUpPrompt: null,
    });
    expect(mockFormatMessage).toHaveBeenCalledWith({
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      provider: 'slack',
      summary:
        'alice approved [owner/repo#42](https://github.com/owner/repo/pull/42).',
    });
    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;

    expect(prompt).toContain('- CI / Lint: success');
    expect(prompt).toContain('- CI / Tests: success');
    expect(prompt).not.toContain('- Merge conflicts: yes');
  });

  it('passes one line per check status into the triage LLM context', async () => {
    mockListCheckRunsForRef.mockResolvedValue({
      data: {
        check_runs: [
          { name: 'CI / Lint', status: 'completed', conclusion: 'failure' },
          { name: 'CI / Tests', status: 'completed', conclusion: 'success' },
        ],
      },
    });
    mockGetCombinedStatusForRef.mockResolvedValue({
      data: {
        state: 'failure',
        total_count: 1,
        statuses: [{ state: 'failure', context: 'legacy-ci' }],
      },
    });

    await preparePrReviewNotificationDelivery({
      taskRun,
      request,
      events,
    });

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;

    expect(prompt).toContain('- CI / Lint: failure');
    expect(prompt).toContain('- CI / Tests: success');
    expect(prompt).toContain('- legacy-ci: failure');
    expect(mockFormatMessage).toHaveBeenCalledWith({
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      provider: 'slack',
      summary:
        'alice approved [owner/repo#42](https://github.com/owner/repo/pull/42).',
    });
  });

  it('passes merge conflicts into the triage LLM context', async () => {
    mockPullsGet.mockResolvedValue({
      data: { head: { sha: 'abc123' }, mergeable: false },
    });

    await preparePrReviewNotificationDelivery({
      taskRun,
      request,
      events,
    });

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;

    expect(prompt).toContain('- Merge conflicts: yes');
  });

  it('still prepares a web-history message when no conversation route can be resolved', async () => {
    mockResolveRoute.mockResolvedValue(null);
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        summary:
          'I reviewed [owner/repo#42](https://github.com/owner/repo/pull/42) on GitHub and found no issues.',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });
    mockFormatMessage.mockReturnValue(
      'I reviewed [owner/repo#42](https://github.com/owner/repo/pull/42) on GitHub and found no issues.',
    );

    await expect(
      preparePrReviewNotificationDelivery({ taskRun, request, events }),
    ).resolves.toEqual({
      post: true,
      route: null,
      text: 'I reviewed [owner/repo#42](https://github.com/owner/repo/pull/42) on GitHub and found no issues.',
      followUpQuestion: null,
      followUpPrompt: null,
    });
    expect(mockGenerateObject).toHaveBeenCalled();
    expect(mockFormatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'teams' }),
    );
  });

  it('propagates a triage skip decision', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: false,
        summary: '',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: eventsWithoutSelfReview,
      }),
    ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });
  });

  it('suppresses Roomote activity represented by a terminal summary for the same head', async () => {
    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'review_comment',
            authorLogin: 'roomote[bot]',
            roomoteAuthored: true,
            reviewHeadSha: 'abc',
          },
        ],
      }),
    ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });

    expect(mockGenerateObject).not.toHaveBeenCalled();
    expect(mockFormatMessage).not.toHaveBeenCalled();
  });

  it('keeps human activity when matching Roomote activity is coalesced', async () => {
    await preparePrReviewNotificationDelivery({
      taskRun,
      request,
      events: [
        {
          kind: 'review_comment',
          authorLogin: 'roomote[bot]',
          roomoteAuthored: true,
          reviewHeadSha: 'abc',
        },
        {
          kind: 'review_comment',
          authorLogin: 'alice',
          reviewHeadSha: 'abc',
        },
      ],
    });

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('- alice left an inline review comment');
    expect(prompt).not.toContain('you (this is your own review)');
  });

  it('keeps Roomote activity from a different reviewed head', async () => {
    await preparePrReviewNotificationDelivery({
      taskRun,
      request,
      events: [
        {
          kind: 'review_comment',
          authorLogin: 'roomote[bot]',
          roomoteAuthored: true,
          reviewHeadSha: 'def',
        },
      ],
    });

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('you (this is your own review)');
  });

  it('keeps Roomote activity while the matching summary is still in progress', async () => {
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [],
      issueComments: [
        {
          id: 'c1',
          author: 'roomote[bot]',
          body: '<!-- roomote-review-summary sha=abc mode=initial -->\n<!-- roomote-review-status:start -->\nReviewing the PR now.\n<!-- roomote-review-status:end -->',
          createdAt: null,
          url: null,
        },
      ],
      warnings: [],
    });

    await preparePrReviewNotificationDelivery({
      taskRun,
      request,
      events: [
        {
          kind: 'review_comment',
          authorLogin: 'roomote[bot]',
          roomoteAuthored: true,
          reviewHeadSha: 'abc',
        },
      ],
    });

    expect(mockGenerateObject).toHaveBeenCalled();
  });

  it('keeps Roomote activity when a human posts a marker-shaped comment', async () => {
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [],
      issueComments: [
        {
          id: 'c1',
          author: 'alice',
          body: '<!-- roomote-review-summary sha=abc mode=initial -->\n<!-- roomote-review-status:start -->\n1 issue outstanding.\n<!-- roomote-review-status:end -->',
          createdAt: null,
          url: null,
        },
      ],
      warnings: [],
    });

    await preparePrReviewNotificationDelivery({
      taskRun,
      request,
      events: [
        {
          kind: 'review_comment',
          authorLogin: 'roomote[bot]',
          roomoteAuthored: true,
          reviewHeadSha: 'abc',
        },
      ],
    });

    expect(mockGenerateObject).toHaveBeenCalled();
  });

  it.each([
    { resolved: true, outdated: false, label: 'resolved' },
    { resolved: false, outdated: true, label: 'outdated' },
  ])('drops $label inline feedback before triage', async (thread) => {
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [
        {
          id: 'thread-1',
          resolved: thread.resolved,
          outdated: thread.outdated,
          path: 'src/example.ts',
          line: 10,
          comments: [{ id: '2000' }],
        },
      ],
      issueComments: [],
      warnings: [],
    });

    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'review_comment',
            providerEventId: 'github-review-comment:2000',
            authorLogin: 'reviewer[bot]',
            automatedAuthorId: 'github:9001',
            body: 'Please change this.',
          },
        ],
      }),
    ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('offers an action for an automated inline comment only while its live thread is open', async () => {
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [
        {
          id: 'thread-1',
          resolved: false,
          outdated: false,
          path: 'src/example.ts',
          line: 10,
          comments: [{ id: '2000' }],
        },
      ],
      issueComments: [],
      warnings: [],
    });
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: false,
        actionableFeedback: false,
        summary: '',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'review_comment',
            providerEventId: 'github-review-comment:2000',
            authorLogin: 'reviewer[bot]',
            automatedAuthorId: 'github:9001',
            body: 'Please change this.',
            url: 'https://github.com/owner/repo/pull/42#discussion_r2000',
          },
        ],
      }),
    ).resolves.toMatchObject({
      post: true,
      followUpQuestion: 'Would you like me to resolve this feedback?',
      followUpPrompt: expect.stringContaining('discussion_r2000'),
    });
    expect(mockGenerateObject.mock.calls[0]?.[0]?.prompt).toContain(
      'Untrusted review content (JSON string): "Please change this."',
    );
  });

  it('bounds the aggregate review activity sent to inference', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        actionableFeedback: false,
        summary: 'A large automated review batch completed.',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: Array.from({ length: 10 }, (_, index) => ({
          kind: 'review_comment' as const,
          providerEventId: `github-review-comment:${4000 + index}`,
          authorLogin: 'reviewer[bot]',
          automatedAuthorId: 'github:9001',
          body: `${index}:`.padEnd(10_000, 'x'),
          url: `https://github.com/owner/repo/pull/42#discussion_r${4000 + index}`,
        })),
      }),
    ).resolves.toMatchObject({ post: true });

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt.length).toBeLessThan(35_000);
    expect(prompt).toContain('Review activity input bounded: omitted');
    expect(prompt).toMatch(/additional events?\./);
  });

  it('never offers an action from automated summary text without a live action signal', async () => {
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [],
      issueComments: [],
      warnings: [],
    });
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        actionableFeedback: true,
        summary: 'The automated review has completed.',
        followUpQuestion: 'Should I fix it?',
        followUpPrompt: 'Fix it.',
      },
    });

    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'issue_comment',
            providerEventId: 'github-issue-comment:3000:revision-2',
            authorLogin: 'reviewer[bot]',
            automatedAuthorId: 'github:9001',
            body: 'All findings are resolved.',
          },
        ],
      }),
    ).resolves.toMatchObject({
      post: true,
      followUpQuestion: null,
      followUpPrompt: null,
    });
  });

  it('never offers an action for the canonical clean self-review status', async () => {
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [],
      issueComments: [],
      warnings: [],
    });
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        actionableFeedback: true,
        summary: 'I found something to resolve.',
        followUpQuestion: 'Should I fix it?',
        followUpPrompt: 'Fix it.',
      },
    });

    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'review_summary',
            authorLogin: 'roomote[bot]',
            roomoteAuthored: true,
            summary: 'No code issues found.',
          },
        ],
      }),
    ).resolves.toMatchObject({
      post: true,
      followUpQuestion: null,
      followUpPrompt: null,
    });
  });

  it('drops a submitted review for an older PR head before triage', async () => {
    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'review',
            providerEventId: 'github-review:1000',
            authorLogin: 'alice',
            reviewState: 'changes_requested',
            reviewHeadSha: 'older-head',
            body: 'Please change this.',
          },
        ],
      }),
    ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('drops a review summary for an older PR head before triage', async () => {
    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'review_summary',
            authorLogin: 'roomote[bot]',
            roomoteAuthored: true,
            reviewHeadSha: 'older-head',
            summary: 'One issue needs attention.',
          },
        ],
      }),
    ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it.each([
    { resolved: true, outdated: false },
    { resolved: false, outdated: true },
  ])(
    'drops a changes-requested review after all of its feedback is handled (%o)',
    async ({ resolved, outdated }) => {
      mockReadSourceControlPullRequest.mockResolvedValue({
        success: true,
        provider: 'github',
        repositoryFullName: 'owner/repo',
        number: 42,
        threads: [
          {
            id: 'thread-1',
            resolved,
            outdated,
            path: 'src/file.ts',
            line: 10,
            comments: [
              {
                id: '2000',
                reviewId: '1000',
                author: 'alice',
                body: 'Please change this.',
                createdAt: null,
                url: null,
              },
            ],
          },
        ],
        issueComments: [],
        warnings: [],
      });

      await expect(
        preparePrReviewNotificationDelivery({
          taskRun,
          request,
          events: [
            {
              kind: 'review',
              providerEventId: 'github-review:1000',
              authorLogin: 'alice',
              reviewState: 'changes_requested',
              reviewHeadSha: 'abc123',
              body: 'Please change this.',
            },
          ],
        }),
      ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });
      expect(mockGenerateObject).not.toHaveBeenCalled();
    },
  );

  it('keeps a changes-requested review while its matching thread is open', async () => {
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [
        {
          id: 'thread-1',
          resolved: false,
          outdated: false,
          path: 'src/file.ts',
          line: 10,
          comments: [
            {
              id: '2000',
              reviewId: '1000',
              author: 'alice',
              body: 'Please change this.',
              createdAt: null,
              url: null,
            },
          ],
        },
      ],
      issueComments: [],
      warnings: [],
    });
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: false,
        actionableFeedback: false,
        summary: '',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'review',
            providerEventId: 'github-review:1000',
            authorLogin: 'alice',
            reviewState: 'changes_requested',
            reviewHeadSha: 'abc123',
            body: 'Please change this.',
          },
        ],
      }),
    ).resolves.toMatchObject({
      post: true,
      followUpQuestion: 'Would you like me to resolve this feedback?',
    });
  });

  it('resolves a custom GitHub App slug before classifying summary authors', async () => {
    mockResolveConfiguredGitHubAppSlug.mockResolvedValue('acme');
    mockIsRoomoteGitHubLogin.mockImplementation((login: string) => {
      expect(mockResolveConfiguredGitHubAppSlug).toHaveBeenCalled();
      return login === 'acme[bot]';
    });
    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [],
      issueComments: [
        {
          id: 'c1',
          author: 'acme[bot]',
          body: '<!-- roomote-review-summary sha=abc mode=initial -->\n<!-- roomote-review-status:start -->\n1 issue outstanding.\n<!-- roomote-review-status:end -->',
          createdAt: null,
          url: null,
        },
      ],
      warnings: [],
    });

    await expect(
      preparePrReviewNotificationDelivery({
        taskRun,
        request,
        events: [
          {
            kind: 'review_comment',
            authorLogin: 'acme[bot]',
            roomoteAuthored: true,
            reviewHeadSha: 'abc',
          },
        ],
      }),
    ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });

    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});

describe('triagePrReviewActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a post decision with the trimmed summary when the model finds the activity worth notifying', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        summary: '  alice approved and bob left one comment.  ',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    const decision = await triagePrReviewActivity({ ...request, events });

    expect(decision).toEqual({
      post: true,
      summary: 'alice approved and bob left one comment.',
      followUpQuestion: null,
      followUpPrompt: null,
    });
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        surface: 'pr_review_notification_triage',
        prompt: expect.stringContaining(
          '- alice submitted a review (state: approved)',
        ),
      }),
    );

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;

    expect(prompt).toContain('Source control provider: GitHub');
    expect(prompt).toContain('Repository: owner/repo');
    expect(prompt).toContain('Pull request: #42');
    expect(prompt).toContain(
      'Pull request URL: https://github.com/owner/repo/pull/42',
    );
    expect(prompt).toContain('- bob left an inline review comment');
    expect(prompt).toContain(
      '- you (this is your own review) finished reviewing the PR and reported: 1 issue to consider.',
    );
    expect(prompt).toContain(
      '(URL: https://github.com/owner/repo/pull/42#issuecomment-7)',
    );
    expect(prompt).not.toContain('Current pull request state:');
  });

  it('reuses one in-flight triage across concurrent linked task deliveries', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        actionableFeedback: false,
        summary: 'alice approved the pull request.',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });
    const firstTelemetry = createPrReviewNotificationTelemetry(events.length);
    const secondTelemetry = createPrReviewNotificationTelemetry(events.length);

    const [first, second] = await Promise.all([
      triagePrReviewActivity({
        ...request,
        events,
        telemetry: firstTelemetry,
      }),
      triagePrReviewActivity({
        ...request,
        taskId: 'task-2',
        events,
        telemetry: secondTelemetry,
      }),
    ]);

    expect(second).toEqual(first);
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
    expect(firstTelemetry).toMatchObject({
      eventsTriaged: events.length,
      triageInvoked: true,
      triageCacheHit: false,
    });
    expect(secondTelemetry).toMatchObject({
      eventsTriaged: events.length,
      triageInvoked: false,
      triageCacheHit: true,
    });
    expect(secondTelemetry.triageInputTokenEstimate).toBeGreaterThan(0);
  });

  it('passes the source-control provider label into the triage prompt', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        summary: 'ok.',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await triagePrReviewActivity({
      ...request,
      sourceControlProvider: 'gitlab',
      events,
    });

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;
    const system = mockGenerateObject.mock.calls[0]?.[0]?.system as string;

    expect(prompt).toContain('Source control provider: GitLab');
    expect(system).toContain('on GitHub and flagged two issues');
    expect(system).toContain('on GitLab and found no code');
    expect(system).toContain(
      'do not omit the platform name on these self-review messages',
    );
    expect(system).toContain(
      'focus the message on offers to address open feedback',
    );
    expect(system).toContain(
      'when any CI check is listed as failure or error, treat it as high-signal',
    );
    expect(system).toContain(
      'when open feedback is already actionable (findings, requested changes, or',
    );
    expect(system).toContain('do not mention that CI is passing or green');
    expect(system).toContain(
      'only mention successful or all-green CI when there is nothing actionable',
    );
    expect(system).toContain(
      'when "Current pull request state" includes CI check lines',
    );
    expect(system).toContain(
      'when "Current pull request state" includes "- Merge conflicts: yes"',
    );
    expect(system).toContain(
      'current pull request state shows a CI check as failure or error',
    );
    expect(system).toContain(
      'current pull request state includes "- Merge conflicts: yes"',
    );
    expect(system).toContain('Would you like me to resolve this?');
  });

  it('includes the latest Roomote review summary comment verbatim for self-review results', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        summary: 'ok.',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await triagePrReviewActivity({
      ...request,
      events,
      context: {
        resolvedThreadCount: 2,
        unresolvedThreadCount: 2,
        latestReviewStatus: '2 issues outstanding.',
        latestReviewSummaryComment:
          '<!-- roomote-review-summary sha=abc mode=initial -->\n<!-- roomote-review-checklist:start -->\n- [ ] `apps/api/src/foo.ts:10` - Handle null actor ids\n- [ ] `apps/api/src/bar.ts:20` - Rename the helper to match its return shape\n<!-- roomote-review-checklist:end -->',
        latestTerminalReviewSummaryHeadSha: 'abc',
        ciStatus: {
          checks: [
            { name: 'CI / Lint', status: 'success' },
            { name: 'CI / Tests', status: 'success' },
          ],
        },
        mergeable: true,
      },
    });

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;

    expect(prompt).toContain(
      'Latest Roomote review summary comment (verbatim):',
    );
    expect(prompt).toContain('Handle null actor ids');
    expect(prompt).toContain('Rename the helper to match its return shape');
    expect(prompt).not.toContain('- Latest automated review status:');
    expect(prompt).toContain('Current pull request state:');
    expect(prompt).toContain('- CI / Lint: success');
    expect(prompt).toContain('- CI / Tests: success');
    expect(prompt).not.toContain('- Merge conflicts: yes');
  });

  it('includes merge conflicts in the triage prompt for self-review results', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        summary: 'ok.',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await triagePrReviewActivity({
      ...request,
      events,
      context: {
        resolvedThreadCount: 0,
        unresolvedThreadCount: 0,
        latestReviewStatus: null,
        latestReviewSummaryComment: null,
        latestTerminalReviewSummaryHeadSha: null,
        ciStatus: {
          checks: [{ name: 'CI / Tests', status: 'failure' }],
        },
        mergeable: false,
      },
    });

    const prompt = mockGenerateObject.mock.calls[0]?.[0]?.prompt as string;

    expect(prompt).toContain('Current pull request state:');
    expect(prompt).toContain('- Merge conflicts: yes');
    expect(prompt).toContain('- CI / Tests: failure');
  });

  it('returns a skip decision when the model says the activity is not worth notifying', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: false,
        summary: '',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await expect(
      triagePrReviewActivity({ ...request, events: eventsWithoutSelfReview }),
    ).resolves.toEqual({ post: false, reason: 'not_worth_notifying' });
  });

  it('always treats a CI failure event as actionable', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: false,
        actionableFeedback: false,
        summary: '',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await expect(
      triagePrReviewActivity({
        ...request,
        events: [
          {
            kind: 'ci_failure',
            authorLogin: 'github-actions',
            checkName: 'CI / Tests',
            url: 'https://github.com/owner/repo/actions/runs/7/job/8',
          },
        ],
      }),
    ).resolves.toEqual({
      post: true,
      summary:
        'CI failed on [owner/repo#42](https://github.com/owner/repo/pull/42).',
      followUpQuestion: 'Would you like me to resolve this CI failure?',
      followUpPrompt:
        'Investigate and resolve the failed CI checks on [owner/repo#42](https://github.com/owner/repo/pull/42). Review [the failed check](https://github.com/owner/repo/actions/runs/7/job/8).',
    });

    expect(mockGenerateObject.mock.calls[0]?.[0]?.prompt).toContain(
      '- CI check CI / Tests failed (URL: https://github.com/owner/repo/actions/runs/7/job/8)',
    );
  });

  it('always passes along self-review results even when the model says they are not worth notifying', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: false,
        summary: 'The automated review found no blocking issues.',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await expect(
      triagePrReviewActivity({ ...request, events }),
    ).resolves.toEqual({
      post: true,
      summary: 'The automated review found no blocking issues.',
      followUpQuestion: null,
      followUpPrompt: null,
    });
  });

  it('throws when the model wants to notify but returns an empty summary', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        worthNotifying: true,
        summary: '   ',
        followUpQuestion: '',
        followUpPrompt: '',
      },
    });

    await expect(
      triagePrReviewActivity({ ...request, events }),
    ).rejects.toThrow('empty summary');
  });
});

describe('gatherPrReviewTriageContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockReadSourceControlPullRequest.mockResolvedValue({
      success: true,
      provider: 'github',
      repositoryFullName: 'owner/repo',
      number: 42,
      threads: [
        { id: 't1', resolved: true, path: null, line: null, comments: [] },
        { id: 't2', resolved: false, path: null, line: null, comments: [] },
        { id: 't3', resolved: null, path: null, line: null, comments: [] },
      ],
      issueComments: [
        {
          id: 'c1',
          author: 'roomote[bot]',
          body: '<!-- roomote-review-summary sha=abc mode=initial -->\n<!-- roomote-review-status:start -->\n**All 1 issue addressed.** [See task](https://example.com)\n<!-- roomote-review-status:end -->',
          createdAt: null,
          url: null,
        },
      ],
      warnings: [],
    });
    mockGreenCiChecks();
  });

  it('collects thread counts and the latest review status', async () => {
    const telemetry = createPrReviewNotificationTelemetry(1);
    const context = await gatherPrReviewTriageContext({
      taskRun,
      repository: request.repository,
      prNumber: request.prNumber,
      telemetry,
    });

    expect(context).toEqual({
      resolvedThreadCount: 1,
      unresolvedThreadCount: 1,
      latestReviewStatus: 'All 1 issue addressed. See task',
      latestReviewSummaryComment:
        '<!-- roomote-review-summary sha=abc mode=initial -->\n<!-- roomote-review-status:start -->\n**All 1 issue addressed.** [See task](https://example.com)\n<!-- roomote-review-status:end -->',
      latestTerminalReviewSummaryHeadSha: 'abc',
      currentHeadSha: 'abc123',
      reviewThreads: [
        { resolved: true, outdated: undefined, commentIds: [] },
        { resolved: false, outdated: undefined, commentIds: [] },
        { resolved: null, outdated: undefined, commentIds: [] },
      ],
      ciStatus: {
        checks: [
          { name: 'CI / Lint', status: 'success' },
          { name: 'CI / Tests', status: 'success' },
        ],
      },
      mergeable: true,
    });
    expect(mockReadSourceControlPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        useGitHubConditionalRequests: true,
        githubToken: 'github-token',
      }),
    );
    expect(mockCreateTaskRunGitHubToken).toHaveBeenCalledTimes(1);
    expect(telemetry.githubTokenMintRequests).toBe(1);
  });

  it('uses ETags for every GitHub live-head polling read', async () => {
    const notModified = () =>
      Object.assign(new Error('Not modified'), {
        status: 304,
        response: { headers: {} },
      });
    mockPullsGet
      .mockResolvedValueOnce({
        data: { head: { sha: 'etag-head' }, mergeable: true },
        headers: { etag: '"pull-v1"' },
        status: 200,
      })
      .mockRejectedValueOnce(notModified());
    mockListCheckRunsForRef
      .mockResolvedValueOnce({
        data: { check_runs: [] },
        headers: { etag: '"checks-v1"' },
        status: 200,
      })
      .mockRejectedValueOnce(notModified());
    mockGetCombinedStatusForRef
      .mockResolvedValueOnce({
        data: { statuses: [], total_count: 0 },
        headers: { etag: '"status-v1"' },
        status: 200,
      })
      .mockRejectedValueOnce(notModified());

    await gatherPrReviewTriageContext({
      taskRun,
      repository: request.repository,
      prNumber: request.prNumber,
    });
    await gatherPrReviewTriageContext({
      taskRun,
      repository: request.repository,
      prNumber: request.prNumber,
    });

    expect(mockPullsGet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: { headers: { 'if-none-match': '"pull-v1"' } },
      }),
    );
    expect(mockListCheckRunsForRef).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: { headers: { 'if-none-match': '"checks-v1"' } },
      }),
    );
    expect(mockGetCombinedStatusForRef).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: { headers: { 'if-none-match': '"status-v1"' } },
      }),
    );
  });

  it('includes mergeable false when the PR has conflicts', async () => {
    mockPullsGet.mockResolvedValue({
      data: { head: { sha: 'abc123' }, mergeable: false },
    });

    const context = await gatherPrReviewTriageContext({
      taskRun,
      repository: request.repository,
      prNumber: request.prNumber,
    });

    expect(context.mergeable).toBe(false);
  });

  it('includes pending CI status when checks are still running', async () => {
    mockListCheckRunsForRef.mockResolvedValue({
      data: {
        check_runs: [
          { name: 'CI / Tests', status: 'in_progress', conclusion: null },
        ],
      },
    });
    mockGetCombinedStatusForRef.mockResolvedValue({
      data: { state: 'pending', statuses: [], total_count: 0 },
    });

    const context = await gatherPrReviewTriageContext({
      taskRun,
      repository: request.repository,
      prNumber: request.prNumber,
    });

    expect(context.ciStatus).toEqual({
      checks: [{ name: 'CI / Tests', status: 'pending' }],
    });
  });

  it('includes one line per Actions check without empty classic statuses', async () => {
    mockListCheckRunsForRef.mockResolvedValue({
      data: {
        check_runs: [
          { name: 'CI / Lint', status: 'completed', conclusion: 'success' },
          { name: 'CI / Tests', status: 'completed', conclusion: 'success' },
        ],
      },
    });
    mockGetCombinedStatusForRef.mockResolvedValue({
      data: { state: 'pending', statuses: [], total_count: 0 },
    });

    const context = await gatherPrReviewTriageContext({
      taskRun,
      repository: request.repository,
      prNumber: request.prNumber,
    });

    expect(context.ciStatus).toEqual({
      checks: [
        { name: 'CI / Lint', status: 'success' },
        { name: 'CI / Tests', status: 'success' },
      ],
    });
  });

  it('skips CI status for non-GitHub source-control providers', async () => {
    const context = await gatherPrReviewTriageContext({
      taskRun,
      repository: request.repository,
      prNumber: request.prNumber,
      sourceControlProvider: 'gitlab',
    });

    expect(context.ciStatus).toBeNull();
    expect(context.mergeable).toBeNull();
    expect(mockPullsGet).not.toHaveBeenCalled();
    expect(mockListCheckRunsForRef).not.toHaveBeenCalled();
    expect(mockGetCombinedStatusForRef).not.toHaveBeenCalled();
  });

  it('degrades to null signals when gathering fails', async () => {
    mockReadSourceControlPullRequest.mockRejectedValue(
      new Error('github unavailable'),
    );
    mockPullsGet.mockRejectedValue(new Error('github unavailable'));

    const context = await gatherPrReviewTriageContext({
      taskRun,
      repository: request.repository,
      prNumber: request.prNumber,
    });

    expect(context).toEqual({
      resolvedThreadCount: null,
      unresolvedThreadCount: null,
      latestReviewStatus: null,
      latestReviewSummaryComment: null,
      latestTerminalReviewSummaryHeadSha: null,
      currentHeadSha: null,
      reviewThreads: [],
      ciStatus: null,
      mergeable: null,
    });
  });
});

describe('collectCiChecks', () => {
  it('keeps distinct checks that share a leaf name segment', () => {
    expect(
      collectCiChecks({
        checkRuns: [
          {
            name: 'CI / Lint',
            status: 'completed',
            conclusion: 'failure',
          },
          {
            name: 'Docs / Lint',
            status: 'completed',
            conclusion: 'success',
          },
        ],
        statusContexts: [],
      }),
    ).toEqual([
      { name: 'CI / Lint', status: 'failure' },
      { name: 'Docs / Lint', status: 'success' },
    ]);
  });

  it('prefers the more severe status when the same full check name collides', () => {
    expect(
      collectCiChecks({
        checkRuns: [
          {
            name: 'CI / Lint',
            status: 'completed',
            conclusion: 'success',
          },
        ],
        statusContexts: [{ context: 'CI / Lint', state: 'failure' }],
      }),
    ).toEqual([{ name: 'CI / Lint', status: 'failure' }]);
  });
});

describe('recordPrReviewNotificationDeliveryBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordTaskMessageEnvelope.mockResolvedValue(undefined);
    mockTrackSlackBotReply.mockResolvedValue(undefined);
    mockSetLatestSlackBotReply.mockResolvedValue(undefined);
  });

  it('persists transcript state and out-of-band Slack reply tracking together', async () => {
    await recordPrReviewNotificationDeliveryBestEffort({
      runId: 1,
      taskId: 'task-1',
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
      messageTs: '999.888',
    });

    expect(mockRecordTaskMessageEnvelope).toHaveBeenCalledWith({
      runId: 1,
      taskId: 'task-1',
      envelope: expect.objectContaining({
        ts: 999888,
        payload: {
          text: 'formatted-message',
          source: 'pr_review_notification',
        },
      }),
    });
    expect(mockTrackSlackBotReply).toHaveBeenCalledWith(
      'C123',
      '111.222',
      '999.888',
    );
    expect(mockSetLatestSlackBotReply).toHaveBeenCalledWith(
      'C123',
      '111.222',
      '999.888',
      'formatted-message',
      { outOfBand: true },
    );
  });

  it('still persists Slack notifications into task history without a message timestamp', async () => {
    await recordPrReviewNotificationDeliveryBestEffort({
      runId: 1,
      taskId: 'task-1',
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
    });

    expect(mockRecordTaskMessageEnvelope).toHaveBeenCalled();
    expect(mockTrackSlackBotReply).not.toHaveBeenCalled();
    expect(mockSetLatestSlackBotReply).not.toHaveBeenCalled();
  });

  it('still persists non-Slack notifications into task history', async () => {
    await recordPrReviewNotificationDeliveryBestEffort({
      runId: 1,
      taskId: 'task-1',
      route: {
        provider: 'teams',
        channelId: '19:abc',
        threadId: 'thread-1',
        serviceUrl: 'https://smba.example.com',
      },
      text: 'formatted-message',
    });

    expect(mockRecordTaskMessageEnvelope).toHaveBeenCalled();
    expect(mockTrackSlackBotReply).not.toHaveBeenCalled();
    expect(mockSetLatestSlackBotReply).not.toHaveBeenCalled();
  });

  it('persists web-only review feedback when there is no conversation route', async () => {
    await recordPrReviewNotificationDeliveryBestEffort({
      runId: 1,
      taskId: 'task-1',
      route: null,
      text: 'formatted-message',
    });

    expect(mockRecordTaskMessageEnvelope).toHaveBeenCalledWith({
      runId: 1,
      taskId: 'task-1',
      envelope: expect.objectContaining({
        payload: {
          text: 'formatted-message',
          source: 'pr_review_notification',
        },
        visibleInTranscript: true,
      }),
    });
    expect(mockTrackSlackBotReply).not.toHaveBeenCalled();
    expect(mockSetLatestSlackBotReply).not.toHaveBeenCalled();
  });
});

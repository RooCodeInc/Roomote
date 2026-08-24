import { z } from 'zod';

const {
  mockFindFirstTaskRun,
  mockFindFirstTaskPullRequest,
  mockFindFirstSlackInstallation,
  mockConsumePending,
  mockRequeuePending,
  mockSchedule,
  mockPrepareDelivery,
  mockRecordDelivery,
  mockPostMessage,
  mockTeamsPostMessage,
  mockTelegramPostMessage,
  mockDiscordPostMessage,
  mockStickyFooterPost,
  mockSetPendingPrReviewAction,
  mockDispatchFollowUp,
  mockNotifyFastAgentParent,
  mockFinalize,
  mockIsDurable,
  mockMigrateLegacy,
  mockRenewLease,
  mockEq,
  MockPrReviewNotificationRateLimitError,
} = vi.hoisted(() => ({
  mockFindFirstTaskRun: vi.fn(),
  mockFindFirstTaskPullRequest: vi.fn(),
  mockFindFirstSlackInstallation: vi.fn(),
  mockConsumePending: vi.fn(),
  mockRequeuePending: vi.fn(),
  mockSchedule: vi.fn(),
  mockPrepareDelivery: vi.fn(),
  mockRecordDelivery: vi.fn(),
  mockPostMessage: vi.fn(),
  mockTeamsPostMessage: vi.fn(),
  mockTelegramPostMessage: vi.fn(),
  mockDiscordPostMessage: vi.fn(),
  mockStickyFooterPost: vi.fn(),
  mockSetPendingPrReviewAction: vi.fn(),
  mockDispatchFollowUp: vi.fn(),
  mockNotifyFastAgentParent: vi.fn(),
  mockFinalize: vi.fn(),
  mockIsDurable: vi.fn(),
  mockMigrateLegacy: vi.fn(),
  mockRenewLease: vi.fn(),
  mockEq: vi.fn((...args: unknown[]) => ({ eq: args })),
  MockPrReviewNotificationRateLimitError: class extends Error {
    constructor(readonly retryAfterMs: number) {
      super('GitHub installation API rate limited during PR review triage.');
    }
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockFindFirstTaskRun(...args),
      },
      taskPullRequests: {
        findFirst: (...args: unknown[]) =>
          mockFindFirstTaskPullRequest(...args),
      },
      slackInstallations: {
        findFirst: (...args: unknown[]) =>
          mockFindFirstSlackInstallation(...args),
      },
    },
  },
  and: vi.fn(() => 'and-condition'),
  eq: mockEq,
  desc: vi.fn(() => 'desc-order'),
  taskRuns: { taskId: 'taskId', createdAt: 'createdAt' },
  taskPullRequests: {
    taskId: 'taskId',
    repository: 'repository',
    prNumber: 'prNumber',
  },
  slackInstallations: { teamId: 'teamId', isActive: 'isActive' },
}));

vi.mock('@roomote/slack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/slack')>();

  return {
    buildSlackPrReviewActionBlocks: actual.buildSlackPrReviewActionBlocks,
    postSlackThreadMessageWithStickyFooter: mockStickyFooterPost,
    SlackNotifier: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

vi.mock('@roomote/sdk/server', () => ({
  PR_REVIEW_NOTIFICATION_DEFER_MS: 5000,
  PR_REVIEW_NOTIFICATION_MAX_DEFERRALS: 3,
  PrReviewNotificationRateLimitError: MockPrReviewNotificationRateLimitError,
  createPrReviewNotificationTelemetry: (eventsReceived: number) => ({
    githubApiCalls: 0,
    eventsReceived,
    eventsTriaged: 0,
    triageInvoked: false,
    triageCacheHit: false,
    triageInputChars: 0,
    triageInputTokenEstimate: 0,
  }),
  prReviewNotificationRequestSchema: z.object({
    taskId: z.string(),
    repository: z.string(),
    prNumber: z.number(),
    prUrl: z.string(),
    deferrals: z.number().default(0),
    immediate: z.boolean().optional(),
    batchKind: z.enum(['human', 'roomote']).optional(),
    batchId: z.string().optional(),
    deliveryIds: z.array(z.string()).optional(),
    leaseToken: z.string().optional(),
    events: z.array(z.unknown()).optional(),
  }),
  consumePendingPrReviewActivity: mockConsumePending,
  requeuePendingPrReviewActivity: mockRequeuePending,
  schedulePrReviewNotificationJob: mockSchedule,
  getCommunicationProviderAdapter: vi.fn(
    async (provider: 'slack' | 'teams' | 'telegram' | 'discord') =>
      ({
        slack: { postMessage: mockPostMessage },
        teams: { postMessage: mockTeamsPostMessage },
        telegram: { postMessage: mockTelegramPostMessage },
        discord: { postMessage: mockDiscordPostMessage },
      })[provider],
  ),
  preparePrReviewNotificationDelivery: mockPrepareDelivery,
  recordPrReviewNotificationDeliveryBestEffort: mockRecordDelivery,
  setPendingPrReviewAction: mockSetPendingPrReviewAction,
  dispatchPrReviewFollowUp: mockDispatchFollowUp,
  notifyFastAgentParentOnPrFeedback: mockNotifyFastAgentParent,
  finalizePrReviewNotificationRequest: mockFinalize,
  renewPrReviewNotificationRequestLease: mockRenewLease,
  isDurablePrReviewNotificationRequest: mockIsDurable,
  migrateLegacyPrReviewNotificationRequest: mockMigrateLegacy,
  attachPendingPrReviewActionMessage: vi.fn(),
}));

import type { Job } from 'bullmq';

import { RunStatus, WORKER_HEARTBEAT_STALE_MS } from '@roomote/types';

import { prReviewNotificationJob } from './pr-review-notification';

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      deferrals: 0,
      ...overrides,
    },
  } as unknown as Job<never, void, string>;
}

const events = [{ kind: 'review_comment' as const, authorLogin: 'alice' }];

describe('prReviewNotificationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDurable.mockReturnValue(true);
    mockMigrateLegacy.mockResolvedValue(0);
    mockRenewLease.mockResolvedValue(true);

    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: { channel: 'C123' },
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockFindFirstTaskPullRequest.mockResolvedValue({
      sourceControlProvider: 'github',
      host: 'github.com',
      repository: 'owner/repo',
      prNumber: 42,
      prTitle: 'PR title',
      prUrl: 'https://github.com/owner/repo/pull/42',
      status: 'open',
      autoHandleFeedbackByUserId: null,
    });
    mockFindFirstSlackInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    });
    mockConsumePending.mockResolvedValue(events);
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
    });
    mockRecordDelivery.mockResolvedValue(undefined);
    mockNotifyFastAgentParent.mockResolvedValue(false);
    mockStickyFooterPost.mockResolvedValue('999.888');
    mockPostMessage.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123',
      messageId: '999.888',
      threadId: '111.222',
    });
    mockTeamsPostMessage.mockResolvedValue({
      provider: 'teams',
      channelId: '19:abc',
      messageId: 'activity-1',
    });
    mockTelegramPostMessage.mockResolvedValue({
      provider: 'telegram',
      channelId: '12345',
      messageId: '901',
    });
  });

  it('migrates an N-1 Redis-owned job and never delivers it directly', async () => {
    mockIsDurable.mockReturnValue(false);
    mockMigrateLegacy.mockResolvedValue(2);

    await prReviewNotificationJob(makeJob() as never);

    expect(mockMigrateLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
    );
    expect(mockFindFirstTaskRun).not.toHaveBeenCalled();
    expect(mockConsumePending).not.toHaveBeenCalled();
  });

  it('does not post when a summary supersedes the claim during preparation', async () => {
    mockRenewLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await prReviewNotificationJob(makeJob() as never);

    expect(mockPrepareDelivery).toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockRecordDelivery).not.toHaveBeenCalled();
  });

  it('posts the aggregated notification to the originating Slack thread when the task is idle', async () => {
    await prReviewNotificationJob(makeJob() as never);

    expect(mockPrepareDelivery).toHaveBeenCalledWith({
      taskRun: expect.objectContaining({ id: 1 }),
      request: {
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        deferrals: 0,
      },
      events,
      telemetry: expect.objectContaining({ eventsReceived: 1 }),
    });
    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        threadTs: '111.222',
        taskId: 'task-1',
        text: 'formatted-message',
        utmCampaign: 'slack.pr_review',
      }),
    );
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockRecordDelivery).toHaveBeenCalledWith({
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
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('passes triaged feedback to the Fast parent event path', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
        },
      },
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Alice requested changes on owner/repo#42.',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });
    mockNotifyFastAgentParent.mockResolvedValue(true);
    mockConsumePending.mockResolvedValue([
      {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
        reviewTaskId: 'review-task',
        reviewHeadSha: 'abc123',
        reviewResult: {
          reviewKind: 'initial',
          outcome: 'findings_remain',
          findingCount: 1,
          approvalStatus: null,
          headSha: 'abc123',
        },
      },
    ]);

    await prReviewNotificationJob(
      makeJob({ deliveryIds: ['delivery-2', 'delivery-1'] }) as never,
    );

    expect(mockNotifyFastAgentParent).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: 1, taskId: 'task-1' }),
      deliveryIds: ['delivery-2', 'delivery-1'],
      pullRequest: {
        provider: 'github',
        host: 'github.com',
        repository: 'owner/repo',
        number: 42,
        title: 'PR title',
        url: 'https://github.com/owner/repo/pull/42',
        status: 'open',
      },
      summary: 'Alice requested changes on owner/repo#42.',
      reviewTaskId: 'review-task',
      reviewHeadSha: 'abc123',
      reviewResult: {
        reviewKind: 'initial',
        outcome: 'findings_remain',
        findingCount: 1,
        approvalStatus: null,
        headSha: 'abc123',
      },
      suggestedActionQuestion: 'Want me to take a look?',
      suggestedActionPrompt: 'Address the review feedback on owner/repo#42.',
    });
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockDispatchFollowUp).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockRecordDelivery).toHaveBeenCalledWith({
      runId: 1,
      taskId: 'task-1',
      route: null,
      text: 'Alice requested changes on owner/repo#42.\nWant me to take a look?',
    });
  });

  it('notifies the Fast parent before auto-dispatching opted-in feedback', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
        },
      },
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockFindFirstTaskPullRequest.mockResolvedValue({
      sourceControlProvider: 'github',
      host: 'github.com',
      repository: 'owner/repo',
      prNumber: 42,
      prTitle: 'PR title',
      prUrl: 'https://github.com/owner/repo/pull/42',
      status: 'open',
      autoHandleFeedbackByUserId: 'user-9',
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Alice requested changes on owner/repo#42.',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });
    mockDispatchFollowUp.mockResolvedValue({ outcome: 'resumed', runId: 12 });
    mockNotifyFastAgentParent.mockResolvedValue(true);

    await prReviewNotificationJob(makeJob() as never);

    expect(mockNotifyFastAgentParent).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Alice requested changes on owner/repo#42.',
      }),
    );
    expect(mockNotifyFastAgentParent.mock.calls[0]?.[0]).not.toHaveProperty(
      'suggestedActionPrompt',
    );
    expect(mockDispatchFollowUp).toHaveBeenCalledWith({
      provider: 'slack',
      taskId: 'task-1',
      slackTeamId: 'T123',
      channelId: 'C123',
      threadId: '111.222',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
      actingUserId: 'user-9',
    });
    expect(mockNotifyFastAgentParent.mock.invocationCallOrder[0]).toBeLessThan(
      mockDispatchFollowUp.mock.invocationCallOrder[0]!,
    );
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
  });

  it('does not auto-dispatch when Fast-parent delivery fails', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
        },
      },
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockFindFirstTaskPullRequest.mockResolvedValue({
      sourceControlProvider: 'github',
      host: 'github.com',
      repository: 'owner/repo',
      prNumber: 42,
      prTitle: 'PR title',
      prUrl: 'https://github.com/owner/repo/pull/42',
      status: 'open',
      autoHandleFeedbackByUserId: 'user-9',
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Alice requested changes on owner/repo#42.',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });
    mockNotifyFastAgentParent.mockRejectedValue(
      new Error('Fast parent unavailable'),
    );

    await expect(prReviewNotificationJob(makeJob() as never)).rejects.toThrow(
      'Fast parent unavailable',
    );

    expect(mockDispatchFollowUp).not.toHaveBeenCalled();
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
  });

  it('short-circuits generic Discord delivery after Fast parent delivery', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
        },
      },
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      text: 'Alice requested changes on owner/repo#42.',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });
    mockNotifyFastAgentParent.mockResolvedValue(true);

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
    expect(mockRecordDelivery).toHaveBeenCalledWith({
      runId: 1,
      taskId: 'task-1',
      route: null,
      text: 'Alice requested changes on owner/repo#42.\nWant me to take a look?',
    });
    expect(mockFinalize).toHaveBeenCalled();
  });

  it('uses the originating workspace installation when identifiers collide', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T-second',
        channelId: 'C-shared',
        threadId: '111.222',
      },
      text: 'formatted-message',
    });
    mockFindFirstSlackInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-second',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockEq).toHaveBeenCalledWith('teamId', 'T-second');
    const SlackNotifier = vi.mocked(
      (await import('@roomote/slack')).SlackNotifier,
    );
    expect(SlackNotifier).toHaveBeenCalledWith('xoxb-second');
    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-shared',
        threadTs: '111.222',
      }),
    );
  });

  it('posts Yes/Dismiss action buttons and stores the pending offer when the triage produced a follow-up', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSetPendingPrReviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'slack',
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        channelId: 'C123',
        threadId: '111.222',
        followUpPrompt: 'Address the review feedback on owner/repo#42.',
        nonce: expect.any(String),
      }),
    );

    const postedCall = mockStickyFooterPost.mock.calls[0]?.[0];
    expect(postedCall.text).toBe('formatted-message\nWant me to take a look?');
    const blocks = postedCall.blocks as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      expect.objectContaining({
        type: 'markdown',
        text: 'formatted-message',
      }),
      expect.objectContaining({
        block_id: 'pr_review_action_question',
        text: expect.objectContaining({ text: 'Want me to take a look?' }),
      }),
      expect.objectContaining({
        type: 'actions',
        block_id: 'pr_review_action',
      }),
    ]);
    // Both buttons carry the stored nonce so the click handler can claim it.
    const storedNonce = mockSetPendingPrReviewAction.mock.calls[0]?.[0]?.nonce;
    const actionsBlock = blocks[2] as {
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actionsBlock.elements.map((element) => element.action_id)).toEqual([
      'pr_review_action_yes',
      'pr_review_action_auto',
      'pr_review_action_dismiss',
    ]);
    for (const element of actionsBlock.elements) {
      expect(JSON.parse(element.value)).toEqual({ nonce: storedNonce });
    }

    // The task-history record carries the question as trailing text.
    expect(mockRecordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'formatted-message\nWant me to take a look?',
      }),
    );
  });

  it('posts callback buttons and stores the pending offer for Telegram routes', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'telegram',
        channelId: '12345',
        threadId: 'thread-9',
      },
      text: 'formatted-message',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSetPendingPrReviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'telegram',
        channelId: '12345',
        threadId: 'thread-9',
        followUpPrompt: 'Address the review feedback on owner/repo#42.',
        nonce: expect.any(String),
      }),
    );
    const storedNonce = mockSetPendingPrReviewAction.mock.calls[0]?.[0]?.nonce;
    expect(mockTelegramPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'formatted-message\nWant me to take a look?',
        buttons: [
          [
            expect.objectContaining({
              text: 'Resolve these issues',
              callbackData: `prr:y:${storedNonce}`,
            }),
            expect.objectContaining({
              text: 'Auto-resolve on this PR',
              callbackData: `prr:a:${storedNonce}`,
            }),
            expect.objectContaining({
              text: 'Dismiss',
              callbackData: `prr:d:${storedNonce}`,
            }),
          ],
        ],
      }),
    );
  });

  it('keeps Teams routes on the plain trailing-question text', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'teams',
        channelId: '19:abc',
        threadId: 'thread-1',
        serviceUrl: 'https://smba.example.com',
      },
      text: 'formatted-message',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockTeamsPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'formatted-message\nWant me to take a look?',
      }),
    );
    expect(mockTeamsPostMessage.mock.calls[0]?.[0]?.buttons).toBeUndefined();
  });

  it('auto-dispatches the follow-up and posts an informational line when auto-handling is enabled', async () => {
    mockFindFirstTaskPullRequest.mockResolvedValue({
      status: 'open',
      autoHandleFeedbackByUserId: 'user-9',
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });
    mockDispatchFollowUp.mockResolvedValue({ outcome: 'resumed', runId: 12 });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockDispatchFollowUp).toHaveBeenCalledWith({
      provider: 'slack',
      taskId: 'task-1',
      channelId: 'C123',
      threadId: '111.222',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
      actingUserId: 'user-9',
    });
    // Informational line, no offer buttons, no pending record.
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    const postedCall = mockStickyFooterPost.mock.calls[0]?.[0];
    expect(postedCall.text).toContain("New review feedback — I'm on it");
    expect(postedCall.blocks).toEqual([
      {
        type: 'markdown',
        text: expect.stringContaining("New review feedback — I'm on it"),
      },
    ]);
    expect(mockRecordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("New review feedback — I'm on it"),
      }),
    );
  });

  it('falls back to the interactive offer when auto-dispatch is unavailable', async () => {
    mockFindFirstTaskPullRequest.mockResolvedValue({
      status: 'open',
      autoHandleFeedbackByUserId: 'user-9',
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });
    mockDispatchFollowUp.mockResolvedValue({ outcome: 'unavailable' });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSetPendingPrReviewAction).toHaveBeenCalled();
    const postedCall = mockStickyFooterPost.mock.calls[0]?.[0];
    expect(postedCall.blocks).toBeDefined();
  });

  it('posts plain text without buttons when the triage produced no follow-up', async () => {
    await prReviewNotificationJob(makeJob() as never);

    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    const postedCall = mockStickyFooterPost.mock.calls[0]?.[0];
    expect(postedCall.text).toBe('formatted-message');
    expect(postedCall.blocks).toEqual([
      { type: 'markdown', text: 'formatted-message' },
    ]);
  });

  it('consumes an immediately promoted Roomote review cycle', async () => {
    await prReviewNotificationJob(
      makeJob({
        immediate: true,
        batchKind: 'roomote',
        batchId: 'cycle-1',
      }) as never,
    );

    expect(mockConsumePending).toHaveBeenCalledWith({
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      batchKind: 'roomote',
      batchId: 'cycle-1',
      immediate: true,
    });
  });

  it('posts to Teams conversations with markdown formatting', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'teams',
        channelId: '19:abc',
        threadId: 'thread-1',
        serviceUrl: 'https://smba.example.com',
      },
      text: 'formatted-message',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockTeamsPostMessage).toHaveBeenCalledWith({
      channelId: '19:abc',
      serviceUrl: 'https://smba.example.com',
      threadId: 'thread-1',
      replyToMessageId: 'thread-1',
      text: 'formatted-message',
      textFormat: 'markdown',
    });
    expect(mockRecordDelivery).toHaveBeenCalledWith({
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
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('posts to Telegram chats as plain text', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'telegram',
        channelId: '12345',
        threadId: '77',
      },
      text: 'formatted-message',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockTelegramPostMessage).toHaveBeenCalledWith({
      channelId: '12345',
      threadId: '77',
      text: 'formatted-message',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('posts to Discord task threads with markdown formatting', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      text: 'formatted-message',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockDiscordPostMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      text: 'formatted-message',
      textFormat: 'markdown',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('defers while the task is actively running', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: {},
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSchedule).toHaveBeenCalledWith({
      request: expect.objectContaining({ deferrals: 1 }),
      delayMs: 5000,
    });
    expect(mockConsumePending).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('defers during follow-up turns on a live sandbox before the cap', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: {},
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Idle,
      taskPhase: 'running',
      workerHeartbeatAt: new Date(),
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSchedule).toHaveBeenCalledWith({
      request: expect.objectContaining({ deferrals: 1 }),
      delayMs: 5000,
    });
    expect(mockConsumePending).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('posts immediately when a running phase is backed by a stale worker heartbeat', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: { channel: 'C123' },
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Idle,
      taskPhase: 'running',
      workerHeartbeatAt: new Date(Date.now() - WORKER_HEARTBEAT_STALE_MS - 1),
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockConsumePending).toHaveBeenCalled();
    expect(mockPrepareDelivery).toHaveBeenCalled();
    expect(mockStickyFooterPost).toHaveBeenCalled();
  });

  it('releases deferred feedback exactly once after a live worker heartbeat becomes stale', async () => {
    const liveRun = {
      id: 1,
      payload: { channel: 'C123' },
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Idle,
      taskPhase: 'running',
      workerHeartbeatAt: new Date(),
    };
    const deadRun = {
      ...liveRun,
      workerHeartbeatAt: new Date(Date.now() - WORKER_HEARTBEAT_STALE_MS - 1),
    };
    mockFindFirstTaskRun.mockResolvedValue(deadRun);
    mockFindFirstTaskRun.mockResolvedValueOnce(liveRun);
    mockConsumePending.mockResolvedValueOnce(events).mockResolvedValueOnce([]);

    await prReviewNotificationJob(makeJob() as never);
    await prReviewNotificationJob(makeJob({ deferrals: 1 }) as never);
    await prReviewNotificationJob(makeJob({ deferrals: 1 }) as never);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockConsumePending).toHaveBeenCalledTimes(2);
    expect(mockPrepareDelivery).toHaveBeenCalledTimes(1);
    expect(mockStickyFooterPost).toHaveBeenCalledTimes(1);
  });

  it('keeps feedback deferred across a worker restart until the replacement run settles', async () => {
    const replacementRun = {
      id: 2,
      payload: { channel: 'C123' },
      slackThreadTs: '111.222',
      sourceRunId: 1,
      status: RunStatus.Running,
      taskPhase: 'running',
      workerHeartbeatAt: new Date(),
    };
    mockFindFirstTaskRun
      .mockResolvedValueOnce(replacementRun)
      .mockResolvedValueOnce({
        ...replacementRun,
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
      });

    await prReviewNotificationJob(makeJob() as never);
    await prReviewNotificationJob(makeJob({ deferrals: 1 }) as never);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockConsumePending).toHaveBeenCalledTimes(1);
    expect(mockPrepareDelivery).toHaveBeenCalledTimes(1);
    expect(mockStickyFooterPost).toHaveBeenCalledTimes(1);
    expect(mockRecordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 2, taskId: 'task-1' }),
    );
  });

  it('drops at the deferral cap when an idle running phase has a fresh heartbeat', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: {},
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Idle,
      taskPhase: 'running',
      workerHeartbeatAt: new Date(),
    });

    await prReviewNotificationJob(makeJob({ deferrals: 3 }) as never);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockConsumePending).toHaveBeenCalled();
    expect(mockPrepareDelivery).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
  });

  it('drops pending activity without posting when the deferral cap is reached while still running', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: {},
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    await prReviewNotificationJob(makeJob({ deferrals: 3 }) as never);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockConsumePending).toHaveBeenCalled();
    expect(mockPrepareDelivery).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips (and drains) when the PR is already merged', async () => {
    mockFindFirstTaskPullRequest.mockResolvedValue({ status: 'merged' });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockConsumePending).toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips silently when there is no pending activity', async () => {
    mockConsumePending.mockResolvedValue([]);

    await prReviewNotificationJob(makeJob() as never);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('records review feedback to task history when the task has no conversation routing', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: null,
      text: 'I reviewed owner/repo#42 on GitHub and found no issues.',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockRecordDelivery).toHaveBeenCalledWith({
      runId: 1,
      taskId: 'task-1',
      route: null,
      text: 'I reviewed owner/repo#42 on GitHub and found no issues.',
    });
  });

  it('skips without posting when the notification is not worth sending', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: false,
      reason: 'not_worth_notifying',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockNotifyFastAgentParent).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockRequeuePending).not.toHaveBeenCalled();
  });

  it('requeues drained events and rethrows when delivery preparation fails', async () => {
    mockPrepareDelivery.mockRejectedValue(new Error('model unavailable'));

    await expect(prReviewNotificationJob(makeJob() as never)).rejects.toThrow(
      'model unavailable',
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockRequeuePending).toHaveBeenCalledWith({
      target: {
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
      },
      events,
    });
  });

  it('durably defers installation rate limits without immediate job retry', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    mockPrepareDelivery.mockRejectedValue(
      new MockPrReviewNotificationRateLimitError(900_000),
    );
    const job = makeJob({
      deliveryIds: ['delivery-1'],
      leaseToken: 'lease-1',
      events,
    });

    await expect(
      prReviewNotificationJob(job as never),
    ).resolves.toBeUndefined();

    expect(mockSchedule).toHaveBeenCalledWith({
      request: job.data,
      delayMs: 915_000,
      countDeferral: false,
    });
    expect(mockRequeuePending).not.toHaveBeenCalled();
  });

  it('requeues drained events and rethrows when posting fails', async () => {
    mockStickyFooterPost.mockRejectedValue(new Error('slack down'));

    await expect(prReviewNotificationJob(makeJob() as never)).rejects.toThrow(
      'slack down',
    );

    expect(mockRequeuePending).toHaveBeenCalledWith({
      target: {
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
      },
      events,
    });
  });
});

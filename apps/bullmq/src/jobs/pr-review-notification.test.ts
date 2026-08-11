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
  mockDiscordUpdateMessage,
  mockGetCommunicationProviderAdapter,
  mockStickyFooterPost,
  mockSetPendingPrReviewAction,
  mockDiscardPendingPrReviewAction,
  mockDispatchFollowUp,
  mockGetAggregateDelivery,
  mockMarkDeliveriesEligible,
  mockUpdateAggregateTriage,
  mockUpdateDelivery,
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
  mockDiscordUpdateMessage: vi.fn(),
  mockGetCommunicationProviderAdapter: vi.fn(),
  mockStickyFooterPost: vi.fn(),
  mockSetPendingPrReviewAction: vi.fn(),
  mockDiscardPendingPrReviewAction: vi.fn(),
  mockDispatchFollowUp: vi.fn(),
  mockGetAggregateDelivery: vi.fn(),
  mockMarkDeliveriesEligible: vi.fn(),
  mockUpdateAggregateTriage: vi.fn(),
  mockUpdateDelivery: vi.fn(),
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
  eq: vi.fn(() => 'eq-condition'),
  desc: vi.fn(() => 'desc-order'),
  getPrReviewAggregateDelivery: (...args: unknown[]) =>
    mockGetAggregateDelivery(...args),
  markPrReviewDeliveriesEligible: (...args: unknown[]) =>
    mockMarkDeliveriesEligible(...args),
  updatePrReviewAggregateTriage: (...args: unknown[]) =>
    mockUpdateAggregateTriage(...args),
  updatePrReviewDelivery: (...args: unknown[]) => mockUpdateDelivery(...args),
  PR_REVIEW_DELIVERY_ALERT_AFTER_MS: 15 * 60_000,
  PR_REVIEW_DELIVERY_MAX_ATTEMPTS: 5,
  PR_REVIEW_DELIVERY_RETRY_DELAYS_MS: [0, 60_000, 300_000, 900_000, 1_800_000],
  taskRuns: { taskId: 'taskId', createdAt: 'createdAt' },
  taskPullRequests: {
    taskId: 'taskId',
    repository: 'repository',
    prNumber: 'prNumber',
  },
  slackInstallations: { isActive: 'isActive' },
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
  prReviewNotificationRequestSchema: z.object({
    aggregateId: z.string().optional(),
    taskId: z.string(),
    repository: z.string(),
    prNumber: z.number(),
    prUrl: z.string(),
    deferrals: z.number().default(0),
    immediate: z.boolean().optional(),
    batchKind: z.enum(['human', 'roomote']).optional(),
    batchId: z.string().optional(),
  }),
  consumePendingPrReviewActivity: mockConsumePending,
  requeuePendingPrReviewActivity: mockRequeuePending,
  schedulePrReviewNotificationJob: mockSchedule,
  getCommunicationProviderAdapter: (...args: unknown[]) =>
    mockGetCommunicationProviderAdapter(...args),
  preparePrReviewNotificationDelivery: mockPrepareDelivery,
  recordPrReviewNotificationDeliveryBestEffort: mockRecordDelivery,
  setPendingPrReviewAction: mockSetPendingPrReviewAction,
  dispatchPrReviewFollowUp: mockDispatchFollowUp,
  attachPendingPrReviewActionMessage: vi.fn(),
  discardPendingPrReviewAction: mockDiscardPendingPrReviewAction,
  prReviewActivityEventSchema: z.object({
    kind: z.string(),
    authorLogin: z.string(),
  }),
  recordTaskMessageEnvelope: vi.fn(),
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
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
    });
    mockRecordDelivery.mockResolvedValue(undefined);
    mockUpdateAggregateTriage.mockResolvedValue(true);
    mockUpdateDelivery.mockResolvedValue(undefined);
    mockDiscardPendingPrReviewAction.mockResolvedValue(undefined);
    mockGetCommunicationProviderAdapter.mockImplementation(
      async (provider: 'slack' | 'teams' | 'telegram' | 'discord') =>
        ({
          slack: { postMessage: mockPostMessage },
          teams: { postMessage: mockTeamsPostMessage },
          telegram: { postMessage: mockTelegramPostMessage },
          discord: {
            postMessage: mockDiscordPostMessage,
            updateMessage: mockDiscordUpdateMessage,
          },
        })[provider],
    );
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
    mockDiscordPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      messageId: 'message-1',
      threadId: 'thread-1',
    });
    mockDiscordUpdateMessage.mockResolvedValue(undefined);
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
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
      messageTs: '999.888',
    });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('keeps durable aggregate delivery waiting while the owner turn is executing', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {},
      status: RunStatus.Running,
      taskPhase: 'running',
      workerHeartbeatAt: new Date(),
    });
    mockGetAggregateDelivery.mockResolvedValue({
      aggregate: {
        id: 'aggregate-1',
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        sourceControlProvider: 'github',
        reviewHeadSha: 'abc',
        version: 1,
        events,
      },
      deliveries: [],
    });

    await prReviewNotificationJob(
      makeJob({ aggregateId: 'aggregate-1' }) as never,
    );

    expect(mockMarkDeliveriesEligible).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
  });

  it('marks a message-id-less provider response unknown instead of retrying the initial post', async () => {
    const aggregate = {
      id: 'aggregate-1',
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      sourceControlProvider: 'github',
      reviewHeadSha: 'abc',
      version: 1,
      events,
      createdAt: new Date(),
    };
    const deliveries = [
      {
        destination: 'task_history',
        state: 'delivered',
        aggregateVersion: 1,
        attemptCount: 1,
      },
      {
        destination: 'chat',
        state: 'pending',
        aggregateVersion: 0,
        attemptCount: 0,
        eligibleAt: new Date(),
        alertEmittedAt: null,
        chatMessageId: null,
      },
    ];
    mockGetAggregateDelivery.mockResolvedValue({ aggregate, deliveries });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      text: 'formatted-message',
    });
    mockDiscordPostMessage.mockResolvedValue(undefined);

    await prReviewNotificationJob(
      makeJob({ aggregateId: 'aggregate-1' }) as never,
    );

    expect(mockUpdateDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: 'aggregate-1',
        destination: 'chat',
        state: 'unknown',
        nextAttemptAt: null,
        alertEmittedAt: expect.any(Date),
      }),
    );
  });

  it('retries initial delivery when the communication transport is unavailable', async () => {
    const aggregate = {
      id: 'aggregate-1',
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      sourceControlProvider: 'github',
      reviewHeadSha: 'abc',
      version: 1,
      events,
      createdAt: new Date(),
    };
    const deliveries = [
      {
        destination: 'task_history',
        state: 'delivered',
        aggregateVersion: 1,
        attemptCount: 1,
      },
      {
        destination: 'chat',
        state: 'pending',
        aggregateVersion: 0,
        attemptCount: 0,
        eligibleAt: new Date(),
        alertEmittedAt: null,
        chatMessageId: null,
      },
    ];
    mockGetAggregateDelivery.mockResolvedValue({ aggregate, deliveries });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      text: 'formatted-message',
    });
    mockGetCommunicationProviderAdapter.mockResolvedValue(null);

    await prReviewNotificationJob(
      makeJob({ aggregateId: 'aggregate-1' }) as never,
    );

    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
    expect(mockUpdateDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: 'aggregate-1',
        destination: 'chat',
        state: 'failed',
        attemptCount: 1,
        nextAttemptAt: expect.any(Date),
        lastError: 'discord is not connected.',
      }),
    );
  });

  it('keeps the previous action claim when a provider edit fails', async () => {
    const aggregate = {
      id: 'aggregate-1',
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      sourceControlProvider: 'github',
      reviewHeadSha: 'abc',
      version: 2,
      events,
      createdAt: new Date(),
    };
    const deliveries = [
      {
        destination: 'task_history',
        state: 'delivered',
        aggregateVersion: 2,
        attemptCount: 1,
      },
      {
        destination: 'chat',
        state: 'delivered',
        aggregateVersion: 1,
        attemptCount: 1,
        eligibleAt: new Date(),
        alertEmittedAt: null,
        chatMessageId: 'message-1',
        actionNonce: 'previous-nonce',
      },
    ];
    mockGetAggregateDelivery.mockResolvedValue({ aggregate, deliveries });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      text: 'updated-message',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });
    mockDiscordUpdateMessage.mockRejectedValue(new Error('edit failed'));

    await prReviewNotificationJob(
      makeJob({ aggregateId: 'aggregate-1' }) as never,
    );

    expect(mockDiscardPendingPrReviewAction).toHaveBeenCalledTimes(1);
    expect(mockDiscardPendingPrReviewAction).not.toHaveBeenCalledWith(
      'previous-nonce',
    );
    expect(mockUpdateDelivery).toHaveBeenCalledWith({
      aggregateId: 'aggregate-1',
      destination: 'chat',
      state: 'sending',
      actionNonce: 'previous-nonce',
      actionHandledAt: null,
    });
    expect(mockUpdateDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: 'aggregate-1',
        destination: 'chat',
        state: 'failed',
        lastError: 'edit failed',
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
        type: 'section',
        text: expect.objectContaining({ text: 'formatted-message' }),
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
      'pr_review_action_fix_all',
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
              text: 'Fix this review',
              callbackData: `prr:y:${storedNonce}`,
            }),
            expect.objectContaining({
              text: 'Fix all PR feedback',
              callbackData: `prr:f:${storedNonce}`,
            }),
            expect.objectContaining({
              text: 'Auto-fix future feedback',
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

  it('includes the fix-all action in initial Discord notification buttons', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      text: 'formatted-message',
      followUpQuestion: 'Want me to take a look?',
      followUpPrompt: 'Address the review feedback on owner/repo#42.',
    });

    await prReviewNotificationJob(makeJob() as never);

    const storedNonce = mockSetPendingPrReviewAction.mock.calls[0]?.[0]?.nonce;
    expect(mockDiscordPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: 'Fix this review',
              callbackData: `prr:y:${storedNonce}`,
            }),
            expect.objectContaining({
              text: 'Fix all PR feedback',
              callbackData: `prr:f:${storedNonce}`,
            }),
            expect.objectContaining({
              text: 'Auto-fix future feedback',
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

    expect(mockDispatchFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        action: 'auto',
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
        followUpPrompt: 'Address the review feedback on owner/repo#42.',
        actingUserId: 'user-9',
      }),
    );
    // Informational line, no offer buttons, no pending record.
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    const postedCall = mockStickyFooterPost.mock.calls[0]?.[0];
    expect(postedCall.text).toContain("New review feedback — I'm on it");
    expect(postedCall.blocks).toBeUndefined();
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
    expect(postedCall.blocks).toBeUndefined();
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

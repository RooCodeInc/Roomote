import { z } from 'zod';

const {
  mockFindFirstTaskRun,
  mockFindFirstTaskPullRequest,
  mockFindFirstSlackInstallation,
  mockConsumePending,
  mockRequeuePending,
  mockRetrySupersededPrReviewAction,
  mockSchedule,
  mockPrepareDelivery,
  mockPrepareCanonical,
  mockBeginCanonicalPrompt,
  mockBeginCanonicalWebPrompt,
  mockBeginCanonicalWebAutoDispatch,
  mockDispatchCanonicalAutoFollowUp,
  mockReleaseCanonicalWebAutoDispatch,
  mockBeginCanonicalAutoDispatch,
  mockCompleteCanonicalAutoDispatch,
  mockRecordDelivery,
  mockPostMessage,
  mockTeamsPostMessage,
  mockTelegramPostMessage,
  mockDiscordPostMessage,
  mockStickyFooterPost,
  mockSetPendingPrReviewAction,
  mockAttachPendingPrReviewActionMessage,
  mockRetirePrReviewActionMessages,
  mockDispatchFollowUp,
  mockFindAutoHandlePrReviewFeedbackPreference,
  mockNotifyFastAgentParent,
  mockFinalize,
  mockIsDurable,
  mockMigrateLegacy,
  mockRenewLease,
  mockUpdateFastAgentPrReviewOfferStatus,
  mockUpdateTaskPrReviewOfferStatus,
  mockGetCanonicalPrReviewAction,
  mockEq,
  MockPrReviewNotificationRateLimitError,
} = vi.hoisted(() => ({
  mockFindFirstTaskRun: vi.fn(),
  mockFindFirstTaskPullRequest: vi.fn(),
  mockFindFirstSlackInstallation: vi.fn(),
  mockConsumePending: vi.fn(),
  mockRequeuePending: vi.fn(),
  mockRetrySupersededPrReviewAction: vi.fn(),
  mockSchedule: vi.fn(),
  mockPrepareDelivery: vi.fn(),
  mockPrepareCanonical: vi.fn(),
  mockBeginCanonicalPrompt: vi.fn(),
  mockBeginCanonicalWebPrompt: vi.fn(),
  mockBeginCanonicalWebAutoDispatch: vi.fn(),
  mockDispatchCanonicalAutoFollowUp: vi.fn(),
  mockReleaseCanonicalWebAutoDispatch: vi.fn(),
  mockBeginCanonicalAutoDispatch: vi.fn(),
  mockCompleteCanonicalAutoDispatch: vi.fn(),
  mockRecordDelivery: vi.fn(),
  mockPostMessage: vi.fn(),
  mockTeamsPostMessage: vi.fn(),
  mockTelegramPostMessage: vi.fn(),
  mockDiscordPostMessage: vi.fn(),
  mockStickyFooterPost: vi.fn(),
  mockSetPendingPrReviewAction: vi.fn(),
  mockAttachPendingPrReviewActionMessage: vi.fn(),
  mockRetirePrReviewActionMessages: vi.fn(),
  mockDispatchFollowUp: vi.fn(),
  mockFindAutoHandlePrReviewFeedbackPreference: vi.fn(),
  mockNotifyFastAgentParent: vi.fn(),
  mockFinalize: vi.fn(),
  mockIsDurable: vi.fn(),
  mockMigrateLegacy: vi.fn(),
  mockRenewLease: vi.fn(),
  mockUpdateFastAgentPrReviewOfferStatus: vi.fn(),
  mockUpdateTaskPrReviewOfferStatus: vi.fn(),
  mockGetCanonicalPrReviewAction: vi.fn(),
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
  getCanonicalPrReviewAction: (...args: unknown[]) =>
    mockGetCanonicalPrReviewAction(...args),
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
  buildPrReviewNotificationPostInput: (
    route: {
      provider: string;
      channelId: string;
      threadId?: string | null;
      serviceUrl?: string;
    },
    text: string,
  ) => {
    switch (route.provider) {
      case 'teams':
        return {
          channelId: route.channelId,
          serviceUrl: route.serviceUrl,
          ...(route.threadId
            ? { threadId: route.threadId, replyToMessageId: route.threadId }
            : {}),
          text,
          textFormat: 'markdown',
        };
      case 'telegram':
        return {
          channelId: route.channelId,
          ...(route.threadId ? { threadId: route.threadId } : {}),
          text,
        };
      default:
        return {
          channelId: route.channelId,
          ...(route.threadId ? { threadId: route.threadId } : {}),
          text,
          textFormat: 'markdown',
        };
    }
  },
  createPrReviewNotificationTelemetry: (eventsReceived: number) => ({
    githubApiCalls: 0,
    githubTokenMintRequests: 0,
    eventsReceived,
    eventsTriaged: 0,
    triageInvoked: false,
    triageCacheHit: false,
    triageInputChars: 0,
    triageInputTokenEstimate: 0,
  }),
  prReviewNotificationRequestSchema: z
    .object({
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
    })
    .passthrough(),
  consumePendingPrReviewActivity: mockConsumePending,
  requeuePendingPrReviewActivity: mockRequeuePending,
  retrySupersededPrReviewAction: mockRetrySupersededPrReviewAction,
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
  prepareCanonicalPrReviewNotificationRequest: mockPrepareCanonical,
  beginCanonicalPrReviewPrompt: mockBeginCanonicalPrompt,
  beginCanonicalPrReviewWebPrompt: mockBeginCanonicalWebPrompt,
  beginCanonicalPrReviewWebAutoDispatch: mockBeginCanonicalWebAutoDispatch,
  dispatchCanonicalPrReviewAutoFollowUp: mockDispatchCanonicalAutoFollowUp,
  releaseCanonicalPrReviewWebAutoDispatch: mockReleaseCanonicalWebAutoDispatch,
  beginCanonicalPrReviewAutoDispatch: mockBeginCanonicalAutoDispatch,
  completeCanonicalPrReviewAutoDispatch: mockCompleteCanonicalAutoDispatch,
  recordPrReviewNotificationDeliveryBestEffort: mockRecordDelivery,
  setPendingPrReviewAction: mockSetPendingPrReviewAction,
  retirePrReviewActionMessagesBestEffort: mockRetirePrReviewActionMessages,
  dispatchPrReviewFollowUp: mockDispatchFollowUp,
  findAutoHandlePrReviewFeedbackPreference:
    mockFindAutoHandlePrReviewFeedbackPreference,
  notifyFastAgentParentOnPrFeedback: mockNotifyFastAgentParent,
  finalizePrReviewNotificationRequest: mockFinalize,
  renewPrReviewNotificationRequestLease: mockRenewLease,
  isDurablePrReviewNotificationRequest: mockIsDurable,
  migrateLegacyPrReviewNotificationRequest: mockMigrateLegacy,
  attachPendingPrReviewActionMessageWithRetirement:
    mockAttachPendingPrReviewActionMessage,
  updateFastAgentPrReviewOfferStatus: mockUpdateFastAgentPrReviewOfferStatus,
  updateTaskPrReviewOfferStatus: mockUpdateTaskPrReviewOfferStatus,
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
    mockRetrySupersededPrReviewAction.mockResolvedValue(false);
    mockPrepareCanonical.mockResolvedValue(true);
    mockBeginCanonicalPrompt.mockResolvedValue(true);
    mockBeginCanonicalWebPrompt.mockResolvedValue(true);
    mockBeginCanonicalWebAutoDispatch.mockResolvedValue(true);
    mockReleaseCanonicalWebAutoDispatch.mockResolvedValue(true);
    mockBeginCanonicalAutoDispatch.mockResolvedValue(true);
    mockDispatchCanonicalAutoFollowUp.mockImplementation(async (input) => {
      const began = input.route
        ? await mockBeginCanonicalAutoDispatch({
            request: input.request,
            followUpPrompt: input.followUpPrompt,
            targetTaskId: input.targetTaskId,
            actingUserId: input.actingUserId,
            route: input.route,
          })
        : await mockBeginCanonicalWebAutoDispatch({
            request: input.request,
            followUpPrompt: input.followUpPrompt,
            targetTaskId: input.targetTaskId,
            actingUserId: input.actingUserId,
          });
      return began ? mockDispatchFollowUp(input.dispatchInput) : null;
    });
    mockCompleteCanonicalAutoDispatch.mockResolvedValue(true);

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
    mockRecordDelivery.mockResolvedValue(true);
    mockNotifyFastAgentParent.mockResolvedValue(false);
    mockAttachPendingPrReviewActionMessage.mockResolvedValue({
      attached: true,
      superseded: [],
    });
    mockRetirePrReviewActionMessages.mockResolvedValue(undefined);
    mockUpdateFastAgentPrReviewOfferStatus.mockResolvedValue(undefined);
    mockUpdateTaskPrReviewOfferStatus.mockResolvedValue(undefined);
    mockGetCanonicalPrReviewAction.mockResolvedValue({ status: 'dismissed' });
    mockFindAutoHandlePrReviewFeedbackPreference.mockResolvedValue(null);
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

  it('defers when a review action resumes the task during preparation', async () => {
    mockFindFirstTaskRun
      .mockResolvedValueOnce({
        id: 1,
        payload: { channel: 'C123' },
        slackThreadTs: '111.222',
        sourceRunId: null,
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
        workerHeartbeatAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 2,
        payload: { channel: 'C123' },
        slackThreadTs: '111.222',
        sourceRunId: 1,
        status: RunStatus.Running,
        taskPhase: 'running',
        workerHeartbeatAt: new Date(),
      });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockPrepareDelivery).toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledWith({
      request: expect.objectContaining({ deferrals: 1 }),
      delayMs: 5000,
    });
    expect(mockNotifyFastAgentParent).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockRecordDelivery).not.toHaveBeenCalled();
  });

  it('defers when a replacement Fix all run finishes during preparation', async () => {
    mockFindFirstTaskRun
      .mockResolvedValueOnce({
        id: 1,
        payload: { channel: 'C123' },
        slackThreadTs: '111.222',
        sourceRunId: null,
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
        workerHeartbeatAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 2,
        payload: { channel: 'C123' },
        slackThreadTs: '111.222',
        sourceRunId: 1,
        status: RunStatus.Completed,
        taskPhase: 'waiting_for_prompt',
        workerHeartbeatAt: new Date(),
      });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockPrepareDelivery).toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledWith({
      request: expect.objectContaining({ deferrals: 1 }),
      delayMs: 5000,
    });
    expect(mockNotifyFastAgentParent).not.toHaveBeenCalled();
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
      canonicalDeliveryOwned: false,
      run: expect.objectContaining({ id: 1, taskId: 'task-1' }),
      feedbackSourceIds: [expect.any(String)],
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
    const superseded = {
      nonce: 'old-nonce',
      provider: 'slack',
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      channelId: 'C123',
      threadId: '111.222',
      followUpPrompt: 'Old prompt',
      messageId: '888.777',
    };
    mockAttachPendingPrReviewActionMessage.mockResolvedValue({
      attached: true,
      superseded: [superseded],
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
    expect(mockAttachPendingPrReviewActionMessage).toHaveBeenCalledWith(
      storedNonce,
      '999.888',
      expect.objectContaining({
        context: expect.objectContaining({ nonce: storedNonce }),
      }),
    );
    expect(mockRetirePrReviewActionMessages).toHaveBeenCalledWith([superseded]);

    // The task-history record carries the question as trailing text.
    expect(mockRecordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'formatted-message\nWant me to take a look?',
      }),
    );
  });

  it('delivers superseded pre-post feedback without actionable controls', async () => {
    const deliveryId = '77777777-7777-4777-8777-777777777777';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });

    await prReviewNotificationJob(
      makeJob({
        ownershipVersion: 'canonical',
        deliveryId,
        notificationUnitId: '88888888-8888-4888-8888-888888888888',
        deliveryState: 'prepared',
        reviewActionSuperseded: true,
        destinationKey: 'task-1',
        dispatchKey: `pr-review-delivery:${deliveryId}`,
        deliveryIds: [deliveryId],
        leaseToken: '99999999-9999-4999-8999-999999999999',
        events,
      }) as never,
    );

    expect(mockBeginCanonicalPrompt).not.toHaveBeenCalled();
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Review feedback remains.',
        blocks: [{ type: 'markdown', text: 'Review feedback remains.' }],
      }),
    );
    expect(mockRecordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Review feedback remains.' }),
    );
    expect(mockFinalize).toHaveBeenCalled();
  });

  it('immediately retries a pre-post action fenced during delivery', async () => {
    const deliveryId = '67676767-6767-4767-8767-676767676767';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockBeginCanonicalPrompt.mockResolvedValue(false);
    mockRetrySupersededPrReviewAction.mockResolvedValue(true);
    const job = makeJob({
      ownershipVersion: 'canonical',
      deliveryId,
      notificationUnitId: '68686868-6868-4868-8868-686868686868',
      deliveryState: 'claimed',
      destinationKey: 'task-1',
      dispatchKey: `pr-review-delivery:${deliveryId}`,
      deliveryIds: [deliveryId],
      leaseToken: '69696969-6969-4969-8969-696969696969',
      events,
    });

    await prReviewNotificationJob(job as never);

    expect(mockRetrySupersededPrReviewAction).toHaveBeenCalledWith(job.data);
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockRecordDelivery).not.toHaveBeenCalled();
  });

  it('retires a canonical Slack prompt that loses its posting fence', async () => {
    const deliveryId = '77777777-7777-4777-8777-777777777777';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Old review feedback.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the old review feedback.',
    });
    mockAttachPendingPrReviewActionMessage.mockResolvedValue({
      attached: false,
      superseded: [],
    });

    await expect(
      prReviewNotificationJob(
        makeJob({
          ownershipVersion: 'canonical',
          deliveryId,
          notificationUnitId: '88888888-8888-4888-8888-888888888888',
          deliveryState: 'claimed',
          destinationKey: 'task-1',
          dispatchKey: `pr-review-delivery:${deliveryId}`,
          deliveryIds: [deliveryId],
          leaseToken: '99999999-9999-4999-8999-999999999999',
          events,
        }) as never,
      ),
    ).rejects.toThrow('Canonical PR review prompt lost its posting fence');
    expect(mockRetirePrReviewActionMessages).toHaveBeenCalledWith(
      [expect.objectContaining({ nonce: deliveryId, messageId: '999.888' })],
      'Superseded by newer PR activity.',
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

  it('attaches Discord actions to the final button-bearing message', async () => {
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
    mockDiscordPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'first-message',
      lastTextMessageId: 'message-with-actions',
    });

    await prReviewNotificationJob(makeJob() as never);

    const storedNonce = mockSetPendingPrReviewAction.mock.calls[0]?.[0]?.nonce;
    expect(mockAttachPendingPrReviewActionMessage).toHaveBeenCalledWith(
      storedNonce,
      'message-with-actions',
      expect.objectContaining({
        context: expect.objectContaining({ nonce: storedNonce }),
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

  it('fences a reclaimed automatic dispatch before remediation starts', async () => {
    const deliveryId = '56565656-5656-4656-8656-565656565656';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockFindAutoHandlePrReviewFeedbackPreference.mockResolvedValue({
      taskId: 'task-1',
      userId: 'user-1',
      destinationKey: 'task-1',
    });
    mockBeginCanonicalAutoDispatch.mockResolvedValue(false);
    mockRetrySupersededPrReviewAction.mockResolvedValue(true);
    const job = makeJob({
      ownershipVersion: 'canonical',
      deliveryId,
      notificationUnitId: '57575757-5757-4757-8757-575757575757',
      deliveryState: 'auto_dispatch_pending',
      destinationKey: 'task-1',
      dispatchKey: `pr-review-delivery:${deliveryId}`,
      deliveryIds: [deliveryId],
      leaseToken: '58585858-5858-4858-8858-585858585858',
      events,
    });

    await prReviewNotificationJob(job as never);

    expect(mockBeginCanonicalAutoDispatch).toHaveBeenCalledTimes(1);
    expect(mockRetrySupersededPrReviewAction).toHaveBeenCalledWith(job.data);
    expect(mockDispatchFollowUp).not.toHaveBeenCalled();
  });

  it('keeps repeated review and CI cycles on auto-dispatch while a prior cycle retries', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: {
        fastAgentParent: {
          sessionId: 'fc175d6f-29e1-48b5-a724-fc03ef6a20d9',
          conversation: {
            surface: 'slack',
            workspaceId: 'T123',
            conversationId: 'C123:111.222',
            replyTarget: { channelId: 'C123', threadId: '111.222' },
          },
        },
      },
      slackThreadTs: null,
      sourceRunId: null,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockFindAutoHandlePrReviewFeedbackPreference.mockResolvedValue({
      taskId: 'parent-task',
      userId: 'user-9',
    });
    mockConsumePending
      .mockResolvedValueOnce([
        {
          kind: 'review_summary',
          reviewTaskId: 'review-task',
          reviewHeadSha: 'new-green-head',
          summary: 'The same review finding remains unresolved.',
        },
      ])
      .mockResolvedValueOnce([
        {
          kind: 'review_summary',
          reviewTaskId: 'review-task',
          reviewHeadSha: 'new-green-head',
          summary: 'The same review finding remains unresolved.',
        },
      ])
      .mockResolvedValueOnce([
        {
          kind: 'check_run',
          providerEventId: 'check-run-1',
          checkName: 'Roomote code review',
          summary: 'One issue remains outstanding.',
        },
      ]);
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      text: 'The same review finding remains unresolved.',
      followUpQuestion: 'Want me to resolve this finding?',
      followUpPrompt: 'Resolve the repeated finding on owner/repo#42.',
    });
    mockDispatchFollowUp
      .mockResolvedValueOnce({ outcome: 'unavailable' })
      .mockResolvedValueOnce({ outcome: 'resumed', runId: 12 })
      .mockResolvedValueOnce({ outcome: 'queued', runId: 13 });
    mockNotifyFastAgentParent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    await prReviewNotificationJob(
      makeJob({
        taskId: 'linked-review-task',
        events: [
          {
            kind: 'review_summary',
            reviewTaskId: 'review-task',
            reviewHeadSha: 'new-green-head',
          },
        ],
      }) as never,
    );
    await prReviewNotificationJob(
      makeJob({
        taskId: 'linked-review-task',
        deferrals: 1,
        events: [
          {
            kind: 'review_summary',
            reviewTaskId: 'review-task',
            reviewHeadSha: 'new-green-head',
          },
        ],
      }) as never,
    );
    await prReviewNotificationJob(
      makeJob({
        taskId: 'duplicate-linked-review-task',
        events: [
          {
            kind: 'check_run',
            providerEventId: 'check-run-1',
            checkName: 'Roomote code review',
          },
        ],
      }) as never,
    );

    expect(mockFindAutoHandlePrReviewFeedbackPreference).toHaveBeenCalledWith({
      sourceControlProvider: 'github',
      host: 'github.com',
      repositoryId: undefined,
      repository: 'owner/repo',
      prNumber: 42,
    });
    expect(mockDispatchFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'parent-task',
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
        actingUserId: 'user-9',
      }),
    );
    expect(mockDispatchFollowUp).toHaveBeenCalledTimes(3);
    expect(mockSchedule).toHaveBeenCalledWith({
      request: expect.objectContaining({
        taskId: 'linked-review-task',
        deferrals: 1,
      }),
      delayMs: 5000,
    });
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockNotifyFastAgentParent).toHaveBeenCalledWith(
      expect.not.objectContaining({
        suggestedActionQuestion: expect.any(String),
      }),
    );
  });

  it('uses auto-handling enabled while notification preparation was in flight', async () => {
    mockFindFirstTaskPullRequest
      .mockResolvedValueOnce({
        status: 'open',
        autoHandleFeedbackByUserId: null,
      })
      .mockResolvedValue({
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
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("New review feedback — I'm on it"),
      }),
    );
  });

  it('defers opted-in feedback when auto-dispatch is temporarily unavailable', async () => {
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

    expect(mockSchedule).toHaveBeenCalledWith({
      request: expect.objectContaining({ deferrals: 1 }),
      delayMs: 5000,
    });
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).not.toHaveBeenCalled();
    expect(mockRecordDelivery).not.toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('auto-dispatches deferred opted-in feedback once the task becomes resumable', async () => {
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
    mockDispatchFollowUp
      .mockResolvedValueOnce({ outcome: 'unavailable' })
      .mockResolvedValueOnce({ outcome: 'resumed', runId: 12 });

    await prReviewNotificationJob(makeJob() as never);
    await prReviewNotificationJob(makeJob({ deferrals: 1 }) as never);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockDispatchFollowUp).toHaveBeenCalledTimes(2);
    expect(mockSetPendingPrReviewAction).not.toHaveBeenCalled();
    expect(mockStickyFooterPost).toHaveBeenCalledTimes(1);
    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("New review feedback — I'm on it"),
      }),
    );
    expect(mockRecordDelivery).toHaveBeenCalledTimes(1);
    expect(mockFinalize).toHaveBeenCalledTimes(1);
  });

  it('falls back to an interactive offer after auto-dispatch exhausts its deferrals', async () => {
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

    await prReviewNotificationJob(makeJob({ deferrals: 3 }) as never);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockSetPendingPrReviewAction).toHaveBeenCalled();
    expect(mockStickyFooterPost).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: expect.any(Array) }),
    );
    expect(mockFinalize).toHaveBeenCalledTimes(1);
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
      messageTs: 'activity-1',
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
    const settledReplacementRun = {
      ...replacementRun,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
    };
    mockFindFirstTaskRun
      .mockResolvedValueOnce(replacementRun)
      .mockResolvedValue(settledReplacementRun);

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

  it('publishes an actionable canonical offer for a web-only standard task', async () => {
    const deliveryId = '11111111-1111-4111-8111-111111111111';
    const leaseToken = '22222222-2222-4222-8222-222222222222';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: null,
      text: 'Review feedback remains.',
      followUpQuestion: 'Would you like me to resolve these issues?',
      followUpPrompt: 'Resolve the review feedback.',
    });

    await prReviewNotificationJob(
      makeJob({
        ownershipVersion: 'canonical',
        deliveryId,
        deliveryState: 'claimed',
        deliveryIds: [deliveryId],
        leaseToken,
      }) as never,
    );

    expect(mockBeginCanonicalWebPrompt).toHaveBeenCalledWith({
      request: expect.objectContaining({ deliveryId }),
      followUpPrompt: 'Resolve the review feedback.',
    });
    expect(mockRecordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        reviewAction: {
          deliveryId,
          question: 'Would you like me to resolve these issues?',
        },
      }),
    );
    expect(mockAttachPendingPrReviewActionMessage).toHaveBeenCalledWith(
      deliveryId,
      deliveryId,
      { leaseToken },
    );
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('dismisses a persisted web offer that loses its publish fence', async () => {
    const deliveryId = '11111111-1111-4111-8111-111111111111';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: null,
      text: 'Review feedback remains.',
      followUpQuestion: 'Would you like me to resolve these issues?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockAttachPendingPrReviewActionMessage.mockResolvedValue({
      attached: false,
      superseded: [],
    });

    await expect(
      prReviewNotificationJob(
        makeJob({
          ownershipVersion: 'canonical',
          deliveryId,
          deliveryState: 'claimed',
          deliveryIds: [deliveryId],
          leaseToken: '22222222-2222-4222-8222-222222222222',
        }) as never,
      ),
    ).rejects.toThrow('Canonical web task review offer lost its publish fence');
    expect(mockUpdateTaskPrReviewOfferStatus).toHaveBeenCalledWith({
      taskId: 'task-1',
      deliveryIds: [deliveryId],
      status: 'dismissed',
    });
  });

  it('keeps a web offer live when its publish fence was re-leased rather than superseded', async () => {
    const deliveryId = '11111111-1111-4111-8111-111111111112';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: null,
      text: 'Review feedback remains.',
      followUpQuestion: 'Would you like me to resolve these issues?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockAttachPendingPrReviewActionMessage.mockResolvedValue({
      attached: false,
      superseded: [],
    });
    mockGetCanonicalPrReviewAction.mockResolvedValue({
      status: 'awaiting_user_action',
    });

    await expect(
      prReviewNotificationJob(
        makeJob({
          ownershipVersion: 'canonical',
          deliveryId,
          deliveryState: 'claimed',
          deliveryIds: [deliveryId],
          leaseToken: '22222222-2222-4222-8222-222222222223',
        }) as never,
      ),
    ).rejects.toThrow('Canonical web task review offer lost its publish fence');
    expect(mockGetCanonicalPrReviewAction).toHaveBeenCalledWith(deliveryId);
    expect(mockUpdateTaskPrReviewOfferStatus).not.toHaveBeenCalled();
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

  it.each([0, 1, 2])(
    'retains a canonical preparation claim only while queue retries remain (prior failures: %s)',
    async (attemptsMade) => {
      mockPrepareDelivery.mockRejectedValue(new Error('model unavailable'));
      const job = {
        ...makeJob({
          ownershipVersion: 'canonical',
          deliveryId: '11111111-1111-4111-8111-111111111111',
          deliveryState: 'claimed',
          deliveryIds: ['11111111-1111-4111-8111-111111111111'],
          leaseToken: '22222222-2222-4222-8222-222222222222',
          events,
        }),
        attemptsMade,
        opts: { attempts: 3 },
      };

      await expect(prReviewNotificationJob(job as never)).rejects.toThrow(
        'model unavailable',
      );
      expect(mockRequeuePending).toHaveBeenCalledTimes(
        attemptsMade === 2 ? 1 : 0,
      );
      expect(mockPostMessage).not.toHaveBeenCalled();
    },
  );

  it('releases a canonical claim when its preparation transition fails despite remaining retries', async () => {
    mockPrepareCanonical.mockRejectedValue(new Error('transition failed'));
    const job = {
      ...makeJob({
        ownershipVersion: 'canonical',
        deliveryId: '11111111-1111-4111-8111-111111111111',
        deliveryState: 'claimed',
        deliveryIds: ['11111111-1111-4111-8111-111111111111'],
        leaseToken: '22222222-2222-4222-8222-222222222222',
        events,
      }),
      attemptsMade: 0,
      opts: { attempts: 3 },
    };

    await expect(prReviewNotificationJob(job as never)).rejects.toThrow(
      'transition failed',
    );
    expect(mockRequeuePending).toHaveBeenCalledOnce();
  });

  it('uses the canonical delivery id as the sole interactive action owner', async () => {
    const deliveryId = '11111111-1111-4111-8111-111111111111';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });

    await prReviewNotificationJob(
      makeJob({
        ownershipVersion: 'canonical',
        deliveryId,
        notificationUnitId: '22222222-2222-4222-8222-222222222222',
        deliveryState: 'claimed',
        destinationKey: 'task-1',
        dispatchKey: `pr-review-delivery:${deliveryId}`,
        deliveryIds: [deliveryId],
        leaseToken: '33333333-3333-4333-8333-333333333333',
        events,
      }) as never,
    );

    expect(mockPrepareCanonical).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId }),
      'Resolve the review feedback.',
    );
    expect(mockBeginCanonicalPrompt).toHaveBeenCalledWith({
      request: expect.objectContaining({ deliveryId }),
      route: expect.objectContaining({ provider: 'slack' }),
      followUpPrompt: 'Resolve the review feedback.',
    });
    expect(mockSetPendingPrReviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: deliveryId,
        canonicalDeliveryId: deliveryId,
      }),
    );
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('publishes a canonical action offer for a web Fast parent', async () => {
    const deliveryId = '77777777-7777-4777-8777-777777777777';
    const leaseToken = '88888888-8888-4888-8888-888888888888';
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          sessionId: '99999999-9999-4999-8999-999999999999',
          conversation: {
            surface: 'web',
            workspaceId: 'user-1',
            conversationId: 'session-1',
          },
        },
      },
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: null,
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockNotifyFastAgentParent.mockResolvedValue(true);

    await prReviewNotificationJob(
      makeJob({
        ownershipVersion: 'canonical',
        deliveryId,
        notificationUnitId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        deliveryState: 'claimed',
        destinationKey: '["web","user-1","session-1"]',
        dispatchKey: `pr-review-delivery:${deliveryId}`,
        deliveryIds: [deliveryId],
        leaseToken,
        events,
      }) as never,
    );

    expect(mockBeginCanonicalWebPrompt).toHaveBeenCalledWith({
      request: expect.objectContaining({ deliveryId }),
      followUpPrompt: 'Resolve the review feedback.',
    });
    expect(mockNotifyFastAgentParent).toHaveBeenCalledWith(
      expect.objectContaining({ reviewActionDeliveryId: deliveryId }),
    );
    expect(mockAttachPendingPrReviewActionMessage).toHaveBeenCalledWith(
      deliveryId,
      deliveryId,
      { leaseToken },
    );
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('dismisses a persisted Fast-session offer that loses its publish fence', async () => {
    const deliveryId = '77777777-7777-4777-8777-777777777777';
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          sessionId: '99999999-9999-4999-8999-999999999999',
          conversation: {
            surface: 'web',
            workspaceId: 'user-1',
            conversationId: 'session-1',
          },
        },
      },
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: null,
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockNotifyFastAgentParent.mockResolvedValue(true);
    mockAttachPendingPrReviewActionMessage.mockResolvedValue({
      attached: false,
      superseded: [],
    });

    await expect(
      prReviewNotificationJob(
        makeJob({
          ownershipVersion: 'canonical',
          deliveryId,
          notificationUnitId: '88888888-8888-4888-8888-888888888888',
          deliveryState: 'claimed',
          destinationKey: '["web","user-1","session-1"]',
          dispatchKey: `pr-review-delivery:${deliveryId}`,
          deliveryIds: [deliveryId],
          leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          events,
        }) as never,
      ),
    ).rejects.toThrow('Canonical Fast web review offer lost its publish fence');
    expect(mockUpdateFastAgentPrReviewOfferStatus).toHaveBeenCalledWith({
      deliveryIds: [deliveryId],
      status: 'dismissed',
    });
  });

  it('auto-dispatches opted-in feedback for a web Fast parent', async () => {
    const deliveryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const leaseToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const destinationKey = '["web","user-1","session-1"]';
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          sessionId: '99999999-9999-4999-8999-999999999999',
          conversation: {
            surface: 'web',
            workspaceId: 'user-1',
            conversationId: 'session-1',
          },
        },
      },
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: null,
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockFindAutoHandlePrReviewFeedbackPreference.mockResolvedValue({
      taskId: 'task-1',
      userId: 'user-1',
      destinationKey,
    });
    mockNotifyFastAgentParent.mockResolvedValue(true);
    mockDispatchFollowUp.mockResolvedValue({ outcome: 'resumed', runId: 99 });

    await prReviewNotificationJob(
      makeJob({
        ownershipVersion: 'canonical',
        deliveryId,
        notificationUnitId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        deliveryState: 'claimed',
        destinationKey,
        dispatchKey: `pr-review-delivery:${deliveryId}`,
        deliveryIds: [deliveryId],
        leaseToken,
        events,
      }) as never,
    );

    expect(mockBeginCanonicalWebAutoDispatch).toHaveBeenCalledWith({
      request: expect.objectContaining({ deliveryId }),
      followUpPrompt: 'Resolve the review feedback.',
      targetTaskId: 'task-1',
      actingUserId: 'user-1',
    });
    expect(mockDispatchFollowUp).toHaveBeenCalledWith({
      provider: 'web',
      taskId: 'task-1',
      followUpPrompt: 'Resolve the review feedback.',
      actingUserId: 'user-1',
      idempotencyKey: `pr-review-delivery:${deliveryId}`,
    });
    expect(mockCompleteCanonicalAutoDispatch).toHaveBeenCalledWith({
      request: expect.objectContaining({ deliveryId }),
      runId: 99,
    });
    expect(mockBeginCanonicalWebPrompt).not.toHaveBeenCalled();
    expect(mockAttachPendingPrReviewActionMessage).not.toHaveBeenCalled();
  });

  it('publishes an interactive web fallback after auto-dispatch retries expire', async () => {
    const deliveryId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const leaseToken = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const destinationKey = '["web","user-1","session-1"]';
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          sessionId: '99999999-9999-4999-8999-999999999999',
          conversation: {
            surface: 'web',
            workspaceId: 'user-1',
            conversationId: 'session-1',
          },
        },
      },
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      workerHeartbeatAt: new Date(),
    });
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: null,
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockFindAutoHandlePrReviewFeedbackPreference.mockResolvedValue({
      taskId: 'task-1',
      userId: 'user-1',
      destinationKey,
    });
    mockNotifyFastAgentParent.mockResolvedValue(true);
    mockDispatchFollowUp.mockResolvedValue({ outcome: 'unavailable' });

    const job = makeJob({
      ownershipVersion: 'canonical',
      deliveryId,
      notificationUnitId: '12121212-1212-4212-8212-121212121212',
      deliveryState: 'auto_dispatch_pending',
      targetTaskId: 'task-1',
      actingUserId: 'user-1',
      destinationKey,
      dispatchKey: `pr-review-delivery:${deliveryId}`,
      deliveryIds: [deliveryId],
      leaseToken,
      deferrals: 3,
      events,
    });

    await prReviewNotificationJob(job as never);

    expect(mockReleaseCanonicalWebAutoDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId }),
    );
    expect(mockBeginCanonicalWebPrompt).toHaveBeenCalledWith({
      request: expect.objectContaining({ deliveryId }),
      followUpPrompt: 'Resolve the review feedback.',
    });
    expect(mockNotifyFastAgentParent).toHaveBeenCalledTimes(2);
    expect(mockNotifyFastAgentParent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        suggestedActionQuestion: 'Resolve it?',
        suggestedActionPrompt: 'Resolve the review feedback.',
        reviewActionDeliveryId: deliveryId,
      }),
    );
    expect(mockAttachPendingPrReviewActionMessage).toHaveBeenCalledWith(
      deliveryId,
      deliveryId,
      { leaseToken },
    );
    expect(mockFinalize).not.toHaveBeenCalled();

    mockAttachPendingPrReviewActionMessage.mockResolvedValueOnce({
      attached: false,
      superseded: [],
    });
    await expect(prReviewNotificationJob(job as never)).rejects.toThrow(
      'Canonical Fast web review fallback lost its publish fence',
    );
    expect(mockUpdateFastAgentPrReviewOfferStatus).toHaveBeenCalledWith({
      deliveryIds: [deliveryId],
      status: 'dismissed',
    });
  });

  it('reuses the canonical dispatch key for automatic follow-up retries', async () => {
    const deliveryId = '44444444-4444-4444-8444-444444444444';
    const dispatchKey = `pr-review-delivery:${deliveryId}`;
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockFindAutoHandlePrReviewFeedbackPreference.mockResolvedValue({
      taskId: 'task-1',
      userId: 'user-1',
      destinationKey: 'task-1',
    });
    mockDispatchFollowUp.mockResolvedValue({ outcome: 'resumed', runId: 99 });

    await prReviewNotificationJob(
      makeJob({
        ownershipVersion: 'canonical',
        deliveryId,
        notificationUnitId: '55555555-5555-4555-8555-555555555555',
        deliveryState: 'claimed',
        destinationKey: 'task-1',
        dispatchKey,
        deliveryIds: [deliveryId],
        leaseToken: '66666666-6666-4666-8666-666666666666',
        events,
      }) as never,
    );

    expect(mockBeginCanonicalAutoDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        targetTaskId: 'task-1',
        actingUserId: 'user-1',
      }),
    );
    expect(mockDispatchFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: dispatchKey }),
    );
    expect(mockCompleteCanonicalAutoDispatch).toHaveBeenCalledWith({
      request: expect.objectContaining({ deliveryId }),
      runId: 99,
    });
  });

  it('keeps a reclaimed prompt on the interactive path', async () => {
    const deliveryId = '77777777-7777-4777-8777-777777777777';
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        slackTeamId: 'T123',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'Review feedback remains.',
      followUpQuestion: 'Resolve it?',
      followUpPrompt: 'Resolve the review feedback.',
    });
    mockFindAutoHandlePrReviewFeedbackPreference.mockResolvedValue({
      taskId: 'task-1',
      userId: 'user-1',
      destinationKey: 'task-1',
    });

    await prReviewNotificationJob(
      makeJob({
        ownershipVersion: 'canonical',
        deliveryId,
        notificationUnitId: '88888888-8888-4888-8888-888888888888',
        deliveryState: 'prompt_posting',
        destinationKey: 'task-1',
        dispatchKey: `pr-review-delivery:${deliveryId}`,
        deliveryIds: [deliveryId],
        leaseToken: '99999999-9999-4999-8999-999999999999',
        events,
      }) as never,
    );

    expect(mockBeginCanonicalPrompt).toHaveBeenCalled();
    expect(mockBeginCanonicalAutoDispatch).not.toHaveBeenCalled();
    expect(mockDispatchFollowUp).not.toHaveBeenCalled();
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

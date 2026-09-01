import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  beginAutoDispatch: vi.fn(),
  completeAutoDispatch: vi.fn(),
  consumePending: vi.fn(),
  dispatchFollowUp: vi.fn(),
  finalize: vi.fn(),
  notifyFastParent: vi.fn(),
  prepareCanonical: vi.fn(),
  prepareDelivery: vi.fn(),
  recordDelivery: vi.fn(),
  renewLease: vi.fn(),
  schedule: vi.fn(),
  stickyFooterPost: vi.fn(),
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/sdk/server')>();
  return {
    ...actual,
    beginCanonicalPrReviewAutoDispatch: mocks.beginAutoDispatch,
    completeCanonicalPrReviewAutoDispatch: mocks.completeAutoDispatch,
    consumePendingPrReviewActivity: mocks.consumePending,
    dispatchPrReviewFollowUp: mocks.dispatchFollowUp,
    finalizePrReviewNotificationRequest: mocks.finalize,
    notifyFastAgentParentOnPrFeedback: mocks.notifyFastParent,
    prepareCanonicalPrReviewNotificationRequest: mocks.prepareCanonical,
    preparePrReviewNotificationDelivery: mocks.prepareDelivery,
    recordPrReviewNotificationDeliveryBestEffort: mocks.recordDelivery,
    renewPrReviewNotificationRequestLease: mocks.renewLease,
    schedulePrReviewNotificationJob: mocks.schedule,
  };
});

vi.mock('@roomote/slack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/slack')>();
  return {
    ...actual,
    postSlackThreadMessageWithStickyFooter: mocks.stickyFooterPost,
    SlackNotifier: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

import type { Job } from 'bullmq';

import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskPullRequests,
  taskRuns,
  upsertPrReviewAutoPreference,
  userFactory,
} from '@roomote/db/server';
import { PR_REVIEW_NOTIFICATION_DEFER_MS } from '@roomote/sdk/server';
import { RunStatus } from '@roomote/types';

import { prReviewNotificationJob } from './pr-review-notification';

describe('PR review auto-resolve lifecycle (real database)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps review and CI cycles on auto-dispatch across snapshot persistence', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
      slackThreadTs: '111.222',
    });
    const repository = `owner/worker-preference-${task.id}`;
    const fastParent = {
      sessionId: randomUUID(),
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: 'C123:111.222',
        replyTarget: { channelId: 'C123', threadId: '111.222' },
      },
    };
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Completed,
      snapshotId: null,
      payload: { fastAgentParent: fastParent },
    });
    await db.insert(taskPullRequests).values({
      taskId: task.id,
      sourceControlProvider: 'github',
      host: 'github.com',
      repository,
      prNumber: 42,
      prUrl: `https://github.com/${repository}/pull/42`,
      status: 'open',
    });
    const destinationKey = JSON.stringify(['slack', 'T123', 'C123:111.222']);
    await upsertPrReviewAutoPreference({
      sourceControlProvider: 'github',
      host: 'github.com',
      repository,
      prNumber: 42,
      enabledByUserId: user.id,
      sourceTaskId: task.id,
      sourceDestinationKey: destinationKey,
    });

    mocks.prepareCanonical.mockResolvedValue(true);
    mocks.renewLease.mockResolvedValue(true);
    mocks.prepareDelivery.mockResolvedValue({
      post: true,
      text: 'One review issue remains.',
      followUpQuestion: 'Would you like me to resolve this issue?',
      followUpPrompt: 'Resolve the outstanding review issue.',
    });
    mocks.notifyFastParent.mockResolvedValue(true);
    mocks.beginAutoDispatch.mockResolvedValue(true);
    mocks.completeAutoDispatch.mockResolvedValue(true);
    mocks.recordDelivery.mockResolvedValue(true);
    mocks.consumePending
      .mockResolvedValueOnce([
        {
          kind: 'review_summary',
          authorLogin: 'roomote-community[bot]',
          reviewTaskId: 'review-task',
          reviewHeadSha: 'head-sha',
          summary: 'One review issue remains.',
        },
      ])
      .mockResolvedValueOnce([
        {
          kind: 'review_summary',
          authorLogin: 'roomote-community[bot]',
          reviewTaskId: 'review-task',
          reviewHeadSha: 'head-sha',
          summary: 'One review issue remains.',
        },
      ])
      .mockResolvedValueOnce([
        {
          kind: 'ci_failure',
          authorLogin: 'roomote-community[bot]',
          providerEventId: 'check-run-1',
          checkName: 'Roomote code review',
          summary: 'The review check still reports one issue.',
        },
      ]);
    mocks.dispatchFollowUp
      .mockResolvedValueOnce({ outcome: 'unavailable' })
      .mockResolvedValueOnce({ outcome: 'resumed', runId: 12 })
      .mockResolvedValueOnce({ outcome: 'queued', runId: 13 });

    const makeJob = (input: {
      deliveryId: string;
      deferrals?: number;
      events: unknown[];
    }) =>
      ({
        data: {
          taskId: task.id,
          sourceControlProvider: 'github',
          host: 'github.com',
          repository,
          prNumber: 42,
          prUrl: `https://github.com/${repository}/pull/42`,
          ownershipVersion: 'canonical',
          deliveryId: input.deliveryId,
          deliveryIds: [input.deliveryId],
          notificationUnitId: randomUUID(),
          destinationKey,
          deliveryState: 'claimed',
          leaseToken: randomUUID(),
          deferrals: input.deferrals ?? 0,
          events: input.events,
        },
      }) as unknown as Job<never, void, string>;
    const reviewEvent = {
      kind: 'review_summary',
      authorLogin: 'roomote-community[bot]',
      reviewTaskId: 'review-task',
      reviewHeadSha: 'head-sha',
    };
    const reviewDeliveryId = randomUUID();

    await prReviewNotificationJob(
      makeJob({ deliveryId: reviewDeliveryId, events: [reviewEvent] }),
    );

    expect(mocks.schedule).toHaveBeenCalledWith({
      request: expect.objectContaining({
        deliveryId: reviewDeliveryId,
        deferrals: 1,
      }),
      delayMs: PR_REVIEW_NOTIFICATION_DEFER_MS,
    });
    expect(mocks.stickyFooterPost).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();

    await db
      .update(taskRuns)
      .set({
        snapshotId: `snapshot-${randomUUID()}`,
        snapshotCreatedAt: new Date(),
      })
      .where(eq(taskRuns.id, run.id));

    await prReviewNotificationJob(
      makeJob({
        deliveryId: reviewDeliveryId,
        deferrals: 1,
        events: [reviewEvent],
      }),
    );
    await prReviewNotificationJob(
      makeJob({
        deliveryId: randomUUID(),
        events: [
          {
            kind: 'ci_failure',
            authorLogin: 'roomote-community[bot]',
            providerEventId: 'check-run-1',
            checkName: 'Roomote code review',
          },
        ],
      }),
    );

    expect(mocks.dispatchFollowUp).toHaveBeenCalledTimes(3);
    expect(mocks.notifyFastParent).toHaveBeenCalledTimes(3);
    for (const [input] of mocks.notifyFastParent.mock.calls) {
      expect(input).not.toHaveProperty('suggestedActionQuestion');
      expect(input).not.toHaveProperty('suggestedActionPrompt');
    }
    expect(mocks.stickyFooterPost).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
  });
});

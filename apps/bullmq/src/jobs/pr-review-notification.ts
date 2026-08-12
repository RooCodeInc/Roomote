import { randomUUID } from 'node:crypto';

import { Job } from 'bullmq';

import type { CommunicationPostMessageInput } from '@roomote/communication';
import {
  and,
  db,
  desc,
  eq,
  slackInstallations,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import {
  PR_REVIEW_NOTIFICATION_DEFER_MS,
  PR_REVIEW_NOTIFICATION_MAX_DEFERRALS,
  attachPendingPrReviewActionMessage,
  getCommunicationProviderAdapter,
  type PrReviewNotificationRequest,
  type PrReviewNotificationRoute,
  consumePendingPrReviewActivity,
  dispatchPrReviewFollowUp,
  preparePrReviewNotificationDelivery,
  prReviewNotificationRequestSchema,
  recordPrReviewNotificationDeliveryBestEffort,
  requeuePendingPrReviewActivity,
  schedulePrReviewNotificationJob,
  setPendingPrReviewAction,
} from '@roomote/sdk/server';
import {
  buildSlackPrReviewActionBlocks,
  postSlackThreadMessageWithStickyFooter,
  SlackNotifier,
} from '@roomote/slack';
import {
  buildPrReviewActionCallbackData,
  isTaskExecutingTurn,
  WORKER_HEARTBEAT_STALE_MS,
} from '@roomote/types';

type PrReviewNotificationJob = Job<PrReviewNotificationRequest, void, string>;

function buildPrReviewNotificationPostInput(
  route: PrReviewNotificationRoute,
  text: string,
): CommunicationPostMessageInput {
  switch (route.provider) {
    case 'slack':
      return {
        channelId: route.channelId,
        threadId: route.threadId,
        text,
      };
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
    case 'discord':
      return {
        channelId: route.channelId,
        ...(route.threadId ? { threadId: route.threadId } : {}),
        text,
        textFormat: 'markdown',
      };
  }
}

type PrReviewNotificationAction = {
  /** Summary text in the route provider's link syntax, without the question. */
  summaryText: string;
  question: string;
  followUpPrompt: string;
  repository: string;
  prNumber: number;
  prUrl: string;
};

const BUTTON_ROUTE_PROVIDERS = ['slack', 'discord', 'telegram'] as const;
type ButtonRouteProvider = (typeof BUTTON_ROUTE_PROVIDERS)[number];

function isButtonRouteProvider(
  provider: PrReviewNotificationRoute['provider'],
): provider is ButtonRouteProvider {
  return (BUTTON_ROUTE_PROVIDERS as readonly string[]).includes(provider);
}

async function postPrReviewNotification({
  taskId,
  route,
  text,
  action,
}: {
  taskId: string;
  route: PrReviewNotificationRoute;
  text: string;
  /** When set (button-capable routes only), post the action buttons. */
  action?: PrReviewNotificationAction;
}): Promise<string | null> {
  // Stored before posting: an orphaned record just expires, while a posted
  // message without a record would leave dead buttons.
  const nonce = action ? randomUUID() : null;

  if (action && nonce && isButtonRouteProvider(route.provider)) {
    await setPendingPrReviewAction({
      nonce,
      provider: route.provider,
      taskId,
      repository: action.repository,
      prNumber: action.prNumber,
      prUrl: action.prUrl,
      channelId: route.channelId,
      threadId: route.threadId ?? null,
      followUpPrompt: action.followUpPrompt,
    });
  }

  if (route.provider === 'slack') {
    const slackInstallation = await db.query.slackInstallations.findFirst({
      where: eq(slackInstallations.isActive, true),
      columns: { botAccessToken: true },
    });

    if (!slackInstallation?.botAccessToken) {
      console.warn('[PrReviewNotification] Slack is not connected, skipping');
      return null;
    }

    const slack = new SlackNotifier(slackInstallation.botAccessToken);

    const messageTs = await postSlackThreadMessageWithStickyFooter({
      slack,
      channel: route.channelId,
      threadTs: route.threadId,
      taskId,
      text,
      ...(action && nonce
        ? {
            blocks: buildSlackPrReviewActionBlocks({
              text: action.summaryText,
              question: action.question,
              nonce,
            }),
          }
        : {}),
      utmCampaign: 'slack.pr_review',
    });

    if (nonce && messageTs) {
      await attachPendingPrReviewActionMessage(nonce, messageTs);
    }

    return messageTs;
  }

  const adapter = await getCommunicationProviderAdapter(route.provider);

  if (!adapter) {
    console.warn(
      `[PrReviewNotification] ${route.provider} is not connected, skipping`,
    );
    return null;
  }

  const postInput = buildPrReviewNotificationPostInput(route, text);

  if (action && nonce && isButtonRouteProvider(route.provider)) {
    postInput.buttons = [
      [
        {
          text: 'Resolve these issues',
          callbackData: buildPrReviewActionCallbackData('yes', nonce),
        },
        {
          text: 'Auto-resolve on this PR',
          callbackData: buildPrReviewActionCallbackData('auto', nonce),
        },
        {
          text: 'Dismiss',
          callbackData: buildPrReviewActionCallbackData('dismiss', nonce),
        },
      ],
    ];
  }

  const posted = await adapter.postMessage(postInput);

  if (nonce && posted?.messageId) {
    await attachPendingPrReviewActionMessage(nonce, posted.messageId);
  }

  return null;
}

/**
 * Posts an informational message about new PR review feedback into the owning
 * task's originating conversation once that task
 * is idle. This never starts an agent turn or changes any code on its own.
 */
export const prReviewNotificationJob = async (
  job: PrReviewNotificationJob,
): Promise<void> => {
  const parsed = prReviewNotificationRequestSchema.safeParse(job.data);

  if (!parsed.success) {
    throw new Error(
      `[PrReviewNotification] Invalid job data: ${parsed.error.message}`,
    );
  }

  const data = parsed.data;
  const target = {
    taskId: data.taskId,
    repository: data.repository,
    prNumber: data.prNumber,
    ...(data.batchKind ? { batchKind: data.batchKind } : {}),
    ...(data.batchId ? { batchId: data.batchId } : {}),
    ...(data.immediate ? { immediate: true } : {}),
  };

  const latestJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, data.taskId),
    orderBy: [desc(taskRuns.createdAt)],
  });

  if (!latestJob) {
    console.warn(
      `[PrReviewNotification] No run found for task ${data.taskId}, skipping`,
    );
    await consumePendingPrReviewActivity(target);
    return;
  }

  const isExecutingTurn = isTaskExecutingTurn(
    latestJob.status,
    latestJob.taskPhase,
  );
  const isWorkerHeartbeatStale =
    latestJob.workerHeartbeatAt != null &&
    Date.now() - latestJob.workerHeartbeatAt.getTime() >=
      WORKER_HEARTBEAT_STALE_MS;

  if (isExecutingTurn && !isWorkerHeartbeatStale) {
    if (data.deferrals < PR_REVIEW_NOTIFICATION_MAX_DEFERRALS) {
      await schedulePrReviewNotificationJob({
        request: { ...data, deferrals: data.deferrals + 1 },
        delayMs: PR_REVIEW_NOTIFICATION_DEFER_MS,
      });

      console.log(
        `[PrReviewNotification] Task ${data.taskId} is still running, deferred notification for ${data.repository}#${data.prNumber} (deferral ${data.deferrals + 1})`,
      );
      return;
    }

    console.warn(
      `[PrReviewNotification] Task ${data.taskId} never went idle after ${data.deferrals} deferrals; delivering pending review activity for ${data.repository}#${data.prNumber}`,
    );
  }

  if (isExecutingTurn && isWorkerHeartbeatStale) {
    console.warn(
      `[PrReviewNotification] Task ${data.taskId} has a stale worker heartbeat while its phase is running; delivering pending review activity for ${data.repository}#${data.prNumber}`,
    );
  }

  const prLink = await db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.taskId, data.taskId),
      eq(
        taskPullRequests.sourceControlProvider,
        data.sourceControlProvider ?? 'github',
      ),
      eq(taskPullRequests.repository, data.repository),
      eq(taskPullRequests.prNumber, data.prNumber),
    ),
    columns: { status: true, autoHandleFeedbackByUserId: true },
  });

  if (prLink?.status === 'merged' || prLink?.status === 'closed') {
    console.log(
      `[PrReviewNotification] PR ${data.repository}#${data.prNumber} is already ${prLink.status}, skipping notification`,
    );
    await consumePendingPrReviewActivity(target);
    return;
  }

  const events = await consumePendingPrReviewActivity(target);

  if (events.length === 0) {
    console.log(
      `[PrReviewNotification] No pending review activity for task ${data.taskId} on ${data.repository}#${data.prNumber}, skipping`,
    );
    return;
  }

  try {
    const delivery = await preparePrReviewNotificationDelivery({
      taskRun: latestJob,
      request: data,
      events,
    });

    if (!delivery.post) {
      console.log(
        `[PrReviewNotification] Skipping review-feedback notification for ${data.repository}#${data.prNumber} (${delivery.reason})`,
      );
      return;
    }

    const followUp =
      delivery.followUpQuestion && delivery.followUpPrompt
        ? {
            question: delivery.followUpQuestion,
            prompt: delivery.followUpPrompt,
          }
        : null;
    // Surfaces without buttons (and the task-history record) carry the offer
    // as a trailing question, preserving the pre-elicitation message shape.
    const textWithQuestion = followUp
      ? `${delivery.text}\n${followUp.question}`
      : delivery.text;

    // Auto-handled PRs skip the offer entirely: the prepared follow-up is
    // dispatched straight into the owning task and the conversation gets an
    // informational line instead of buttons. Falls back to the normal offer
    // when the task can no longer be reached (e.g. no resumable snapshot).
    if (
      followUp &&
      prLink?.autoHandleFeedbackByUserId &&
      delivery.route &&
      isButtonRouteProvider(delivery.route.provider)
    ) {
      const dispatched = await dispatchPrReviewFollowUp({
        provider: delivery.route.provider,
        channelId: delivery.route.channelId,
        threadId: delivery.route.threadId ?? null,
        followUpPrompt: followUp.prompt,
        actingUserId: prLink.autoHandleFeedbackByUserId,
      });

      if (dispatched.outcome !== 'unavailable') {
        const autoText = `New review feedback — I'm on it:
${delivery.text}`;
        const messageTs = await postPrReviewNotification({
          taskId: data.taskId,
          route: delivery.route,
          text: autoText,
        });

        await recordPrReviewNotificationDeliveryBestEffort({
          runId: latestJob.id,
          taskId: data.taskId,
          route: delivery.route,
          text: autoText,
          ...(messageTs ? { messageTs } : {}),
        });
        console.log(
          `[PrReviewNotification] Auto-dispatched review feedback for ${data.repository}#${data.prNumber} into task ${data.taskId} (${dispatched.outcome}, run ${dispatched.runId})`,
        );
        return;
      }

      console.warn(
        `[PrReviewNotification] Auto-handle dispatch unavailable for ${data.repository}#${data.prNumber}; falling back to the interactive offer`,
      );
    }

    // Chat delivery is optional (web-only tasks have no route). Task history is
    // always recorded so the web task view shows the self-review summary.
    let messageTs: string | null = null;
    if (delivery.route) {
      messageTs = await postPrReviewNotification({
        taskId: data.taskId,
        route: delivery.route,
        text: textWithQuestion,
        ...(followUp && isButtonRouteProvider(delivery.route.provider)
          ? {
              action: {
                summaryText: delivery.text,
                question: followUp.question,
                followUpPrompt: followUp.prompt,
                repository: data.repository,
                prNumber: data.prNumber,
                prUrl: data.prUrl,
              },
            }
          : {}),
      });
    } else {
      console.log(
        `[PrReviewNotification] No conversation routing for task ${data.taskId}; recording review feedback to task history only`,
      );
    }

    await recordPrReviewNotificationDeliveryBestEffort({
      runId: latestJob.id,
      taskId: data.taskId,
      route: delivery.route,
      text: textWithQuestion,
      ...(messageTs ? { messageTs } : {}),
    });

    if (delivery.route) {
      console.log(
        `[PrReviewNotification] Posted review-feedback notification for ${data.repository}#${data.prNumber} to ${delivery.route.provider} conversation ${delivery.route.channelId}`,
      );
    } else {
      console.log(
        `[PrReviewNotification] Recorded review-feedback notification for ${data.repository}#${data.prNumber} on task ${data.taskId}`,
      );
    }
  } catch (error) {
    // Put the drained events back so a retried job can deliver them.
    try {
      await requeuePendingPrReviewActivity({ target, events });
    } catch {
      // Best effort; the events are lost if Redis is unavailable too.
    }

    throw error;
  }
};

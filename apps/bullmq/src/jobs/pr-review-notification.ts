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
  getCommunicationProviderAdapter,
  type PrReviewNotificationRequest,
  type PrReviewNotificationRoute,
  consumePendingPrReviewActivity,
  preparePrReviewNotificationDelivery,
  prReviewNotificationRequestSchema,
  recordPrReviewNotificationDeliveryBestEffort,
  requeuePendingPrReviewActivity,
  schedulePrReviewNotificationJob,
} from '@roomote/sdk/server';
import {
  buildSlackPrReviewActionBlocks,
  postSlackThreadMessageWithStickyFooter,
  setPendingSlackPrReviewAction,
  SlackNotifier,
} from '@roomote/slack';
import { isTaskExecutingTurn } from '@roomote/types';

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

type SlackPrReviewAction = {
  /** Summary text already in Slack mrkdwn link syntax, without the question. */
  summaryText: string;
  question: string;
  followUpPrompt: string;
  repository: string;
  prNumber: number;
  prUrl: string;
};

async function postPrReviewNotification({
  taskId,
  route,
  text,
  slackAction,
}: {
  taskId: string;
  route: PrReviewNotificationRoute;
  text: string;
  /** When set (Slack routes only), post Yes/Dismiss action buttons. */
  slackAction?: SlackPrReviewAction;
}): Promise<string | null> {
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

    if (slackAction) {
      // Stored before posting: an orphaned record just expires, while a
      // posted message without a record would leave dead buttons.
      const nonce = randomUUID();

      await setPendingSlackPrReviewAction({
        nonce,
        taskId,
        repository: slackAction.repository,
        prNumber: slackAction.prNumber,
        prUrl: slackAction.prUrl,
        channelId: route.channelId,
        threadTs: route.threadId,
        followUpPrompt: slackAction.followUpPrompt,
      });

      return postSlackThreadMessageWithStickyFooter({
        slack,
        channel: route.channelId,
        threadTs: route.threadId,
        taskId,
        text,
        blocks: buildSlackPrReviewActionBlocks({
          text: slackAction.summaryText,
          question: slackAction.question,
          nonce,
        }),
        utmCampaign: 'slack.pr_review',
      });
    }

    return postSlackThreadMessageWithStickyFooter({
      slack,
      channel: route.channelId,
      threadTs: route.threadId,
      taskId,
      text,
      utmCampaign: 'slack.pr_review',
    });
  }

  const adapter = await getCommunicationProviderAdapter(route.provider);

  if (!adapter) {
    console.warn(
      `[PrReviewNotification] ${route.provider} is not connected, skipping`,
    );
    return null;
  }

  await adapter.postMessage(buildPrReviewNotificationPostInput(route, text));

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

  // The notification only posts while the owning task is idle. Hold it while
  // the task is actively working, and once the deferral cap is reached (the
  // task has effectively been running for the whole pending-events window),
  // drop the pending feedback instead of posting mid-run.
  if (isTaskExecutingTurn(latestJob.status, latestJob.taskPhase)) {
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
      `[PrReviewNotification] Task ${data.taskId} never went idle after ${data.deferrals} deferrals, dropping pending review activity for ${data.repository}#${data.prNumber}`,
    );
    await consumePendingPrReviewActivity(target);
    return;
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
    columns: { status: true },
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

    // Chat delivery is optional (web-only tasks have no route). Task history is
    // always recorded so the web task view shows the self-review summary.
    let messageTs: string | null = null;
    if (delivery.route) {
      messageTs = await postPrReviewNotification({
        taskId: data.taskId,
        route: delivery.route,
        text: textWithQuestion,
        ...(followUp && delivery.route.provider === 'slack'
          ? {
              slackAction: {
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

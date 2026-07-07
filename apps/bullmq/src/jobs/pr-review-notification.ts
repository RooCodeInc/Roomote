import { Job } from 'bullmq';

import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import {
  and,
  cloudJobs,
  db,
  desc,
  eq,
  slackInstallations,
  taskPullRequests,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  PR_REVIEW_NOTIFICATION_DEFER_MS,
  PR_REVIEW_NOTIFICATION_MAX_DEFERRALS,
  createTeamsCommunicationProviderFromRuntimeCredentials,
  type PrReviewNotificationRequest,
  type PrReviewNotificationRoute,
  consumePendingPrReviewActivity,
  isPrReviewNotificationEnabled,
  preparePrReviewNotificationDelivery,
  prReviewNotificationRequestSchema,
  recordPrReviewNotificationDeliveryBestEffort,
  requeuePendingPrReviewActivity,
  schedulePrReviewNotificationJob,
} from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';
import { isCloudTaskExecutingTurn } from '@roomote/types';

type PrReviewNotificationJob = Job<PrReviewNotificationRequest, void, string>;

async function postSlackNotification({
  route,
  text,
}: {
  route: Extract<PrReviewNotificationRoute, { provider: 'slack' }>;
  text: string;
}): Promise<string | null> {
  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    columns: { botAccessToken: true },
  });

  if (!slackInstallation) {
    console.warn(
      '[PrReviewNotification] No active Slack installation, skipping',
    );
    return null;
  }

  const notifier = new SlackNotifier(slackInstallation.botAccessToken);
  const messageTs = await notifier.postMessage({
    channel: route.channelId,
    thread_ts: route.threadId,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });

  return typeof messageTs === 'string' && messageTs ? messageTs : null;
}

async function postTeamsNotification({
  route,
  text,
}: {
  route: Extract<PrReviewNotificationRoute, { provider: 'teams' }>;
  text: string;
}): Promise<void> {
  const provider =
    await createTeamsCommunicationProviderFromRuntimeCredentials();

  if (!provider) {
    console.warn(
      '[PrReviewNotification] Teams bot credentials are not configured, skipping',
    );
    return;
  }

  await provider.postMessage({
    channelId: route.channelId,
    serviceUrl: route.serviceUrl,
    ...(route.threadId
      ? { threadId: route.threadId, replyToMessageId: route.threadId }
      : {}),
    text,
    textFormat: 'markdown',
  });
}

async function postTelegramNotification({
  route,
  text,
}: {
  route: Extract<PrReviewNotificationRoute, { provider: 'telegram' }>;
  text: string;
}): Promise<void> {
  if (!Env.TELEGRAM_BOT_TOKEN) {
    console.warn(
      '[PrReviewNotification] Telegram bot token is not configured, skipping',
    );
    return;
  }

  const provider = new TelegramCommunicationProvider({
    botToken: Env.TELEGRAM_BOT_TOKEN,
  });

  await provider.postMessage({
    channelId: route.channelId,
    ...(route.threadId ? { threadId: route.threadId } : {}),
    text,
  });
}

async function postPrReviewNotification({
  route,
  text,
}: {
  route: PrReviewNotificationRoute;
  text: string;
}): Promise<string | null> {
  switch (route.provider) {
    case 'slack':
      return postSlackNotification({ route, text });
    case 'teams':
      await postTeamsNotification({ route, text });
      return null;
    case 'telegram':
      await postTelegramNotification({ route, text });
      return null;
  }
}

/**
 * Posts an informational message about new PR review feedback into the owning
 * task's originating conversation (Slack, Teams, or Telegram) once that task
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
  };

  // Re-check the experimental flag at delivery time so pending notifications
  // drain silently if the flag is turned off after events were queued.
  if (!(await isPrReviewNotificationEnabled('[PrReviewNotification]'))) {
    console.log(
      `[PrReviewNotification] Feature flag disabled, dropping pending review activity for task ${data.taskId} on ${data.repository}#${data.prNumber}`,
    );
    await consumePendingPrReviewActivity(target);
    return;
  }

  const latestJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.taskId, data.taskId),
    orderBy: [desc(cloudJobs.createdAt)],
  });

  if (!latestJob) {
    console.warn(
      `[PrReviewNotification] No cloud job found for task ${data.taskId}, skipping`,
    );
    await consumePendingPrReviewActivity(target);
    return;
  }

  // The notification only posts while the owning task is idle. Hold it while
  // the task is actively working, and once the deferral cap is reached (the
  // task has effectively been running for the whole pending-events window),
  // drop the pending feedback instead of posting mid-run.
  if (isCloudTaskExecutingTurn(latestJob.status, latestJob.taskPhase)) {
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
      cloudJob: latestJob,
      request: data,
      events,
    });

    if (!delivery.post) {
      if (delivery.reason === 'no_conversation_route') {
        console.warn(
          `[PrReviewNotification] No conversation routing for task ${data.taskId}, skipping`,
        );
        return;
      }

      console.log(
        `[PrReviewNotification] Skipping review-feedback notification for ${data.repository}#${data.prNumber} (${delivery.reason})`,
      );
      return;
    }

    const messageTs = await postPrReviewNotification({
      route: delivery.route,
      text: delivery.text,
    });
    await recordPrReviewNotificationDeliveryBestEffort({
      cloudJobId: latestJob.id,
      taskId: data.taskId,
      route: delivery.route,
      text: delivery.text,
      ...(messageTs ? { messageTs } : {}),
    });

    console.log(
      `[PrReviewNotification] Posted review-feedback notification for ${data.repository}#${data.prNumber} to ${delivery.route.provider} conversation ${delivery.route.channelId}`,
    );
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

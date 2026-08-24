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
  PrReviewNotificationRateLimitError,
  attachPendingPrReviewActionMessage,
  createPrReviewNotificationTelemetry,
  getCommunicationProviderAdapter,
  type PrReviewNotificationRequest,
  type PrReviewNotificationRoute,
  consumePendingPrReviewActivity,
  dispatchPrReviewFollowUp,
  finalizePrReviewNotificationRequest,
  isDurablePrReviewNotificationRequest,
  renewPrReviewNotificationRequestLease,
  migrateLegacyPrReviewNotificationRequest,
  notifyFastAgentParentOnPrFeedback,
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

function isLiveTaskTurn(run: typeof taskRuns.$inferSelect): boolean {
  if (!isTaskExecutingTurn(run.status, run.taskPhase)) {
    return false;
  }

  return !(
    run.workerHeartbeatAt != null &&
    Date.now() - run.workerHeartbeatAt.getTime() >= WORKER_HEARTBEAT_STALE_MS
  );
}

function logPrReviewNotificationTriage(input: {
  data: PrReviewNotificationRequest;
  eventsDrained: number;
  outcome: 'notify' | 'suppress' | 'rate_limited' | 'error';
  reason?: string;
  durationMs: number;
  telemetry: ReturnType<typeof createPrReviewNotificationTelemetry>;
}): void {
  console.log(
    JSON.stringify({
      event: 'pr_review_notification_triage',
      instanceId: process.env.R_INSTANCE_ID ?? null,
      taskId: input.data.taskId,
      sourceControlProvider: input.data.sourceControlProvider ?? 'github',
      repository: input.data.repository,
      prNumber: input.data.prNumber,
      batchKind: input.data.batchKind ?? null,
      eventsDrained: input.eventsDrained,
      eventsTriaged: input.telemetry.eventsTriaged,
      githubApiCalls: input.telemetry.githubApiCalls,
      triageInvoked: input.telemetry.triageInvoked,
      triageCacheHit: input.telemetry.triageCacheHit,
      triageInputChars: input.telemetry.triageInputChars,
      triageInputTokenEstimate: input.telemetry.triageInputTokenEstimate,
      outcome: input.outcome,
      reason: input.reason ?? null,
      durationMs: input.durationMs,
    }),
  );
}

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

function isButtonRoute(
  route: PrReviewNotificationRoute,
): route is PrReviewNotificationRoute & { provider: ButtonRouteProvider } {
  return isButtonRouteProvider(route.provider);
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
      ...(route.provider === 'slack' ? { slackTeamId: route.slackTeamId } : {}),
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
      where: and(
        eq(slackInstallations.teamId, route.slackTeamId),
        eq(slackInstallations.isActive, true),
      ),
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
        : { blocks: [{ type: 'markdown', text }] }),
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
  if (!isDurablePrReviewNotificationRequest(data)) {
    const migrated = await migrateLegacyPrReviewNotificationRequest(data);
    console.log(
      `[PrReviewNotification] Migrated ${migrated} legacy events for ${data.repository}#${data.prNumber} to Postgres`,
    );
    return;
  }

  if (!(await renewPrReviewNotificationRequestLease(data))) {
    console.log(
      `[PrReviewNotification] Delivery claim for ${data.repository}#${data.prNumber} was superseded, skipping`,
    );
    return;
  }
  const target = {
    taskId: data.taskId,
    repository: data.repository,
    prNumber: data.prNumber,
    ...(data.batchKind ? { batchKind: data.batchKind } : {}),
    ...(data.batchId ? { batchId: data.batchId } : {}),
    ...(data.immediate ? { immediate: true } : {}),
    deliveryIds: data.deliveryIds,
    leaseToken: data.leaseToken,
    events: data.events,
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
    await finalizePrReviewNotificationRequest(data, 'suppressed');
    return;
  }

  const isExecutingTurn = isTaskExecutingTurn(
    latestJob.status,
    latestJob.taskPhase,
  );
  const isWorkerHeartbeatStale = isExecutingTurn && !isLiveTaskTurn(latestJob);

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
      `[PrReviewNotification] Task ${data.taskId} never went idle after ${data.deferrals} deferrals, dropping pending review activity for ${data.repository}#${data.prNumber}`,
    );
    await consumePendingPrReviewActivity(target);
    await finalizePrReviewNotificationRequest(data, 'suppressed');
    return;
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
    columns: {
      sourceControlProvider: true,
      host: true,
      repository: true,
      prNumber: true,
      prTitle: true,
      prUrl: true,
      status: true,
      autoHandleFeedbackByUserId: true,
    },
  });

  if (prLink?.status === 'merged' || prLink?.status === 'closed') {
    console.log(
      `[PrReviewNotification] PR ${data.repository}#${data.prNumber} is already ${prLink.status}, skipping notification`,
    );
    await consumePendingPrReviewActivity(target);
    await finalizePrReviewNotificationRequest(data, 'suppressed');
    return;
  }

  const events = await consumePendingPrReviewActivity(target);

  if (events.length === 0) {
    console.log(
      `[PrReviewNotification] No pending review activity for task ${data.taskId} on ${data.repository}#${data.prNumber}, skipping`,
    );
    await finalizePrReviewNotificationRequest(data, 'suppressed');
    return;
  }

  const deliveryStartedAt = Date.now();
  const telemetry = createPrReviewNotificationTelemetry(events.length);

  try {
    const delivery = await preparePrReviewNotificationDelivery({
      taskRun: latestJob,
      request: data,
      events,
      telemetry,
    });

    logPrReviewNotificationTriage({
      data,
      eventsDrained: events.length,
      outcome: delivery.post ? 'notify' : 'suppress',
      ...(!delivery.post ? { reason: delivery.reason } : {}),
      durationMs: Date.now() - deliveryStartedAt,
      telemetry,
    });

    if (!delivery.post) {
      console.log(
        `[PrReviewNotification] Skipping review-feedback notification for ${data.repository}#${data.prNumber} (${delivery.reason})`,
      );
      await finalizePrReviewNotificationRequest(data, 'suppressed');
      return;
    }

    // The task can be resumed by a review action while remote reads and model
    // triage are in flight. Recheck before posting so a bulk-fix run gets the
    // chance to resolve its included threads; the next delivery attempt then
    // filters those handled comments against live provider state.
    const latestBeforeDelivery = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, data.taskId),
      orderBy: [desc(taskRuns.createdAt)],
    });
    const taskChangedDuringPreparation =
      latestBeforeDelivery?.id !== latestJob.id;
    if (
      latestBeforeDelivery &&
      (taskChangedDuringPreparation || isLiveTaskTurn(latestBeforeDelivery))
    ) {
      if (data.deferrals < PR_REVIEW_NOTIFICATION_MAX_DEFERRALS) {
        await schedulePrReviewNotificationJob({
          request: { ...data, deferrals: data.deferrals + 1 },
          delayMs: PR_REVIEW_NOTIFICATION_DEFER_MS,
        });
        console.log(
          `[PrReviewNotification] Task ${data.taskId} changed or resumed while preparing review feedback for ${data.repository}#${data.prNumber}; deferred delivery (deferral ${data.deferrals + 1})`,
        );
        return;
      }

      console.warn(
        `[PrReviewNotification] Task ${data.taskId} changed or resumed while preparing review feedback for ${data.repository}#${data.prNumber}; dropping pending activity after ${data.deferrals} deferrals`,
      );
      await finalizePrReviewNotificationRequest(data, 'suppressed');
      return;
    }

    // Preparing the notification may perform remote reads or model work. A
    // Roomote summary can supersede an inline fallback during that interval,
    // or the lease can expire. Atomically renew the still-current claim at the
    // external side-effect boundary so a replacement worker cannot reclaim it
    // while this worker posts.
    if (!(await renewPrReviewNotificationRequestLease(data))) {
      console.log(
        `[PrReviewNotification] Delivery claim for ${data.repository}#${data.prNumber} was superseded while preparing, skipping`,
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
    const roomoteReviewIdentity = events.find(
      (event) => event.reviewTaskId && event.reviewHeadSha,
    );
    const roomoteReviewResult = events.find(
      (event) => event.reviewResult,
    )?.reviewResult;
    const persistedAutoHandleUserId =
      prLink?.autoHandleFeedbackByUserId ?? null;
    const autoHandleRoute =
      followUp &&
      persistedAutoHandleUserId &&
      delivery.route &&
      isButtonRoute(delivery.route)
        ? delivery.route
        : null;
    const autoHandleUserId = autoHandleRoute ? persistedAutoHandleUserId : null;

    // Fast-parent delivery can fail and release this notification for retry.
    // Complete it before auto-dispatch so a retry cannot enqueue the same
    // resolve prompt twice.
    const deliveredToFastParent = await notifyFastAgentParentOnPrFeedback({
      run: latestJob,
      feedbackSourceIds: events.map(
        (event) =>
          event.providerEventId ??
          [
            event.kind,
            event.authorLogin,
            event.batchId ?? '',
            event.reviewHeadSha ?? '',
            event.reviewState ?? '',
            event.checkName ?? '',
            event.inReplyToId ?? '',
            event.url ?? '',
            String(event.observedAt ?? ''),
            event.summary ?? event.body ?? '',
          ].join('\0'),
      ),
      pullRequest: {
        provider:
          prLink?.sourceControlProvider ??
          data.sourceControlProvider ??
          'github',
        host: prLink?.host,
        repository: prLink?.repository ?? data.repository,
        number: prLink?.prNumber ?? data.prNumber,
        title: prLink?.prTitle,
        url: prLink?.prUrl ?? data.prUrl,
        status: prLink?.status,
      },
      summary: delivery.text,
      ...(roomoteReviewIdentity?.reviewTaskId &&
      roomoteReviewIdentity.reviewHeadSha
        ? {
            reviewTaskId: roomoteReviewIdentity.reviewTaskId,
            reviewHeadSha: roomoteReviewIdentity.reviewHeadSha,
          }
        : {}),
      ...(roomoteReviewResult ? { reviewResult: roomoteReviewResult } : {}),
      ...(followUp && !autoHandleUserId
        ? {
            suggestedActionQuestion: followUp.question,
            suggestedActionPrompt: followUp.prompt,
          }
        : {}),
    });

    let autoHandledText: string | null = null;
    if (followUp && autoHandleUserId && autoHandleRoute) {
      const dispatched = await dispatchPrReviewFollowUp({
        provider: autoHandleRoute.provider,
        taskId: data.taskId,
        ...(autoHandleRoute.provider === 'slack'
          ? { slackTeamId: autoHandleRoute.slackTeamId }
          : {}),
        channelId: autoHandleRoute.channelId,
        threadId: autoHandleRoute.threadId ?? null,
        followUpPrompt: followUp.prompt,
        actingUserId: autoHandleUserId,
      });

      if (dispatched.outcome !== 'unavailable') {
        autoHandledText = `New review feedback — I'm on it:
${delivery.text}`;
        console.log(
          `[PrReviewNotification] Auto-dispatched review feedback for ${data.repository}#${data.prNumber} into task ${data.taskId} (${dispatched.outcome}, run ${dispatched.runId})`,
        );
      } else {
        console.warn(
          `[PrReviewNotification] Auto-handle dispatch unavailable for ${data.repository}#${data.prNumber}; falling back to the interactive offer`,
        );
      }
    }

    if (deliveredToFastParent && (!autoHandleUserId || autoHandledText)) {
      await recordPrReviewNotificationDeliveryBestEffort({
        runId: latestJob.id,
        taskId: data.taskId,
        route: null,
        text: autoHandledText ?? textWithQuestion,
      });
      await finalizePrReviewNotificationRequest(data);
      return;
    }

    // If the automatic dispatch was unavailable, continue into the normal
    // offer path even though the Fast parent already received the summary.

    if (autoHandledText && delivery.route) {
      const messageTs = await postPrReviewNotification({
        taskId: data.taskId,
        route: delivery.route,
        text: autoHandledText,
      });

      await recordPrReviewNotificationDeliveryBestEffort({
        runId: latestJob.id,
        taskId: data.taskId,
        route: delivery.route,
        text: autoHandledText,
        ...(messageTs ? { messageTs } : {}),
      });
      await finalizePrReviewNotificationRequest(data);
      return;
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
    await finalizePrReviewNotificationRequest(data);

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
    if (error instanceof PrReviewNotificationRateLimitError) {
      const jitterMs = Math.floor(Math.random() * 30_000);
      const delayMs = error.retryAfterMs + jitterMs;
      await schedulePrReviewNotificationJob({
        request: data,
        delayMs,
        countDeferral: false,
      });
      console.warn(
        JSON.stringify({
          event: 'pr_review_notification_github_rate_limit',
          instanceId: process.env.R_INSTANCE_ID ?? null,
          taskId: data.taskId,
          repository: data.repository,
          prNumber: data.prNumber,
          status: error.rateLimit?.status ?? null,
          remaining: error.rateLimit?.remaining ?? null,
          resetAt: error.rateLimit?.resetAt ?? null,
          retryAfter: error.rateLimit?.retryAfter ?? null,
          retryAfterMs: error.retryAfterMs,
          scheduledDelayMs: delayMs,
          githubApiCalls:
            error.telemetry?.githubApiCalls ?? telemetry.githubApiCalls,
        }),
      );
      logPrReviewNotificationTriage({
        data,
        eventsDrained: events.length,
        outcome: 'rate_limited',
        reason: 'github_rate_limit',
        durationMs: Date.now() - deliveryStartedAt,
        telemetry: error.telemetry ?? telemetry,
      });
      return;
    }

    logPrReviewNotificationTriage({
      data,
      eventsDrained: events.length,
      outcome: 'error',
      reason: error instanceof Error ? error.name : 'unknown_error',
      durationMs: Date.now() - deliveryStartedAt,
      telemetry,
    });

    // Put the drained events back so a retried job can deliver them.
    try {
      await requeuePendingPrReviewActivity({ target, events });
    } catch {
      // Best effort; the events are lost if Redis is unavailable too.
    }

    throw error;
  }
};

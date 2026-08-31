import { randomUUID } from 'node:crypto';

import { Job } from 'bullmq';

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
  attachPendingPrReviewActionMessageWithRetirement,
  beginCanonicalPrReviewAutoDispatch,
  beginCanonicalPrReviewPrompt,
  beginCanonicalPrReviewWebAutoDispatch,
  beginCanonicalPrReviewWebPrompt,
  buildPrReviewNotificationPostInput,
  createPrReviewNotificationTelemetry,
  getCommunicationProviderAdapter,
  type PrReviewNotificationRequest,
  type PrReviewNotificationRoute,
  consumePendingPrReviewActivity,
  completeCanonicalPrReviewAutoDispatch,
  dispatchPrReviewFollowUp,
  findAutoHandlePrReviewFeedbackPreference,
  finalizePrReviewNotificationRequest,
  isDurablePrReviewNotificationRequest,
  renewPrReviewNotificationRequestLease,
  releaseCanonicalPrReviewWebAutoDispatch,
  retirePrReviewActionMessagesBestEffort,
  migrateLegacyPrReviewNotificationRequest,
  notifyFastAgentParentOnPrFeedback,
  preparePrReviewNotificationDelivery,
  prepareCanonicalPrReviewNotificationRequest,
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
  PR_REVIEW_ACTION_LABELS,
  isTaskExecutingTurn,
  getFastAgentParentFromPayload,
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

function findTaskPullRequestForNotification(data: PrReviewNotificationRequest) {
  return db.query.taskPullRequests.findFirst({
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
      repositoryId: true,
      autoHandleFeedbackByUserId: true,
    },
  });
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
      githubTokenMintRequests: input.telemetry.githubTokenMintRequests,
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
type ButtonPrReviewNotificationRoute = Extract<
  PrReviewNotificationRoute,
  { provider: ButtonRouteProvider }
>;

function isButtonRouteProvider(
  provider: PrReviewNotificationRoute['provider'],
): provider is ButtonRouteProvider {
  return (BUTTON_ROUTE_PROVIDERS as readonly string[]).includes(provider);
}

function isButtonRoute(
  route: PrReviewNotificationRoute,
): route is ButtonPrReviewNotificationRoute {
  return isButtonRouteProvider(route.provider);
}

function getFastParentButtonRoute(
  payload: unknown,
): ButtonPrReviewNotificationRoute | null {
  const parent = getFastAgentParentFromPayload(payload);
  if (
    !parent ||
    parent.conversation.surface === 'automation' ||
    parent.conversation.surface === 'web'
  ) {
    return null;
  }

  const conversation = parent.conversation;
  if (conversation.surface === 'slack') {
    if (!conversation.replyTarget.threadId) {
      return null;
    }
    return {
      provider: 'slack',
      slackTeamId: conversation.workspaceId,
      channelId: conversation.replyTarget.channelId,
      threadId: conversation.replyTarget.threadId,
    };
  }

  // Teams and Telegram can receive the Fast parent event itself, but the PR
  // action-button renderer does not yet have provider-native callbacks there.
  if (conversation.surface !== 'discord') {
    return null;
  }

  return {
    provider: 'discord',
    channelId: conversation.replyTarget.channelId,
    threadId: conversation.replyTarget.threadId ?? null,
  };
}

function getPersistedButtonRoute(
  data: PrReviewNotificationRequest,
): ButtonPrReviewNotificationRoute | null {
  if (!data.routeProvider || !isButtonRouteProvider(data.routeProvider)) {
    return null;
  }
  if (!data.routeChannelId) return null;
  if (data.routeProvider === 'slack') {
    return data.routeWorkspaceId && data.routeThreadId
      ? {
          provider: 'slack',
          slackTeamId: data.routeWorkspaceId,
          channelId: data.routeChannelId,
          threadId: data.routeThreadId,
        }
      : null;
  }
  return {
    provider: data.routeProvider,
    channelId: data.routeChannelId,
    threadId: data.routeThreadId ?? null,
  };
}

async function postPrReviewNotification({
  taskId,
  route,
  text,
  action,
  canonicalDeliveryId,
  canonicalLeaseToken,
}: {
  taskId: string;
  route: PrReviewNotificationRoute;
  text: string;
  /** When set (button-capable routes only), post the action buttons. */
  action?: PrReviewNotificationAction;
  canonicalDeliveryId?: string;
  canonicalLeaseToken?: string;
}): Promise<string | null> {
  // Stored before posting: an orphaned record just expires, while a posted
  // message without a record would leave dead buttons.
  const nonce = action ? (canonicalDeliveryId ?? randomUUID()) : null;
  const pendingAction =
    action && nonce && isButtonRouteProvider(route.provider)
      ? {
          nonce,
          provider: route.provider,
          ...(route.provider === 'slack'
            ? { slackTeamId: route.slackTeamId }
            : {}),
          taskId,
          repository: action.repository,
          prNumber: action.prNumber,
          prUrl: action.prUrl,
          channelId: route.channelId,
          threadId: route.threadId ?? null,
          followUpPrompt: action.followUpPrompt,
          ...(canonicalDeliveryId ? { canonicalDeliveryId } : {}),
        }
      : null;

  if (pendingAction) {
    await setPendingPrReviewAction(pendingAction);
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
      const { attached, superseded } =
        await attachPendingPrReviewActionMessageWithRetirement(
          nonce,
          messageTs,
          {
            ...(canonicalLeaseToken ? { leaseToken: canonicalLeaseToken } : {}),
            ...(pendingAction ? { context: pendingAction } : {}),
          },
        );
      if (canonicalDeliveryId && !attached) {
        throw new Error('Canonical PR review prompt lost its posting fence');
      }
      if (superseded.length > 0) {
        await retirePrReviewActionMessagesBestEffort(superseded);
      }
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
          text: PR_REVIEW_ACTION_LABELS.yes,
          callbackData: buildPrReviewActionCallbackData('yes', nonce),
        },
        {
          text: PR_REVIEW_ACTION_LABELS.auto,
          callbackData: buildPrReviewActionCallbackData('auto', nonce),
        },
        {
          text: PR_REVIEW_ACTION_LABELS.dismiss,
          callbackData: buildPrReviewActionCallbackData('dismiss', nonce),
        },
      ],
    ];
  }

  const posted = await adapter.postMessage(postInput);

  if (nonce && posted?.messageId) {
    const { attached, superseded } =
      await attachPendingPrReviewActionMessageWithRetirement(
        nonce,
        posted.lastTextMessageId ?? posted.messageId,
        {
          ...(canonicalLeaseToken ? { leaseToken: canonicalLeaseToken } : {}),
          ...(pendingAction ? { context: pendingAction } : {}),
        },
      );
    if (canonicalDeliveryId && !attached) {
      throw new Error('Canonical PR review prompt lost its posting fence');
    }
    if (superseded.length > 0) {
      await retirePrReviewActionMessagesBestEffort(superseded);
    }
  }

  return posted?.messageId ?? null;
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
    ownershipVersion: data.ownershipVersion,
    deliveryId: data.deliveryId,
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

  const prLink = await findTaskPullRequestForNotification(data);

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

    if (
      !(await prepareCanonicalPrReviewNotificationRequest(
        data,
        delivery.followUpPrompt ?? null,
      ))
    ) {
      console.log(
        `[PrReviewNotification] Canonical delivery ${data.deliveryId} lost its preparation fence, skipping`,
      );
      return;
    }

    // The task can be resumed by a review action while remote reads and model
    // triage are in flight. Recheck before posting so a bulk-fix run gets the
    // chance to resolve its included threads; the next delivery attempt then
    // filters those handled comments against live provider state.
    const [latestBeforeDelivery, latestPrLinkBeforeDelivery] =
      await Promise.all([
        db.query.taskRuns.findFirst({
          where: eq(taskRuns.taskId, data.taskId),
          orderBy: [desc(taskRuns.createdAt)],
        }),
        findTaskPullRequestForNotification(data),
      ]);
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

    const deliveryPrLink = latestPrLinkBeforeDelivery ?? prLink;
    if (
      deliveryPrLink?.status === 'merged' ||
      deliveryPrLink?.status === 'closed'
    ) {
      console.log(
        `[PrReviewNotification] PR ${data.repository}#${data.prNumber} became ${deliveryPrLink.status} while preparing, skipping notification`,
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
    const fallbackAutoHandleRoute = getFastParentButtonRoute(latestJob.payload);
    const fastParent = getFastAgentParentFromPayload(latestJob.payload);
    const isWebFastParent = fastParent?.conversation.surface === 'web';
    const persistedAutoHandleRoute = getPersistedButtonRoute(data);
    const canonicalPreference =
      data.ownershipVersion === 'canonical'
        ? await findAutoHandlePrReviewFeedbackPreference({
            sourceControlProvider: data.sourceControlProvider ?? 'github',
            host: data.host,
            repositoryId: data.repositoryId,
            repository: data.repository,
            prNumber: data.prNumber,
          })
        : null;
    const autoHandlePreference =
      data.deliveryState === 'prompt_posting'
        ? null
        : data.deliveryState === 'auto_dispatch_pending' &&
            data.targetTaskId &&
            data.actingUserId
          ? {
              taskId: data.targetTaskId,
              userId: data.actingUserId,
              destinationKey: data.destinationKey ?? null,
            }
          : data.ownershipVersion === 'canonical'
            ? canonicalPreference &&
              (!canonicalPreference.destinationKey ||
                canonicalPreference.destinationKey === data.destinationKey)
              ? canonicalPreference
              : null
            : deliveryPrLink?.autoHandleFeedbackByUserId
              ? {
                  taskId: data.taskId,
                  userId: deliveryPrLink.autoHandleFeedbackByUserId,
                  destinationKey: null,
                }
              : fallbackAutoHandleRoute
                ? await findAutoHandlePrReviewFeedbackPreference({
                    sourceControlProvider:
                      data.sourceControlProvider ?? 'github',
                    host: deliveryPrLink?.host,
                    repositoryId: deliveryPrLink?.repositoryId,
                    repository: data.repository,
                    prNumber: data.prNumber,
                  })
                : null;
    const directAutoHandleRoute =
      delivery.route && isButtonRoute(delivery.route) ? delivery.route : null;
    const autoHandleRoute =
      followUp && autoHandlePreference
        ? (persistedAutoHandleRoute ??
          directAutoHandleRoute ??
          fallbackAutoHandleRoute)
        : null;
    const webAutoDispatchKey =
      followUp &&
      autoHandlePreference &&
      isWebFastParent &&
      data.ownershipVersion === 'canonical'
        ? (data.dispatchKey ?? null)
        : null;
    const canAutoHandleWeb = webAutoDispatchKey !== null;
    const autoHandleUserId =
      autoHandleRoute || canAutoHandleWeb ? autoHandlePreference?.userId : null;

    // Fast-parent delivery can fail and release this notification for retry.
    // Complete it before auto-dispatch so a retry cannot enqueue the same
    // resolve prompt twice.
    let webReviewActionDeliveryId: string | null = null;
    if (
      followUp &&
      isWebFastParent &&
      !autoHandleUserId &&
      data.ownershipVersion === 'canonical' &&
      data.deliveryId
    ) {
      if (
        !(await beginCanonicalPrReviewWebPrompt({
          request: data,
          followUpPrompt: followUp.prompt,
        }))
      ) {
        console.log(
          `[PrReviewNotification] Canonical Fast web delivery ${data.deliveryId} lost its prompt-posting fence, skipping`,
        );
        return;
      }
      webReviewActionDeliveryId = data.deliveryId;
    }
    const feedbackSourceIds = events.map(
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
    );
    const notifyFastParent = (options: {
      includeSuggestedAction: boolean;
      reviewActionDeliveryId?: string;
    }) =>
      notifyFastAgentParentOnPrFeedback({
        run: latestJob,
        feedbackSourceIds,
        pullRequest: {
          provider:
            deliveryPrLink?.sourceControlProvider ??
            data.sourceControlProvider ??
            'github',
          host: deliveryPrLink?.host,
          repository: deliveryPrLink?.repository ?? data.repository,
          number: deliveryPrLink?.prNumber ?? data.prNumber,
          title: deliveryPrLink?.prTitle,
          url: deliveryPrLink?.prUrl ?? data.prUrl,
          status: deliveryPrLink?.status,
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
        ...(followUp && options.includeSuggestedAction
          ? {
              suggestedActionQuestion: followUp.question,
              suggestedActionPrompt: followUp.prompt,
            }
          : {}),
        canonicalDeliveryOwned: data.ownershipVersion === 'canonical',
        ...(options.reviewActionDeliveryId
          ? { reviewActionDeliveryId: options.reviewActionDeliveryId }
          : {}),
      });
    const deliveredToFastParent = await notifyFastParent({
      includeSuggestedAction: Boolean(followUp && !autoHandleUserId),
      ...(webReviewActionDeliveryId
        ? { reviewActionDeliveryId: webReviewActionDeliveryId }
        : {}),
    });

    if (deliveredToFastParent && webReviewActionDeliveryId) {
      const { attached } =
        await attachPendingPrReviewActionMessageWithRetirement(
          webReviewActionDeliveryId,
          webReviewActionDeliveryId,
          { leaseToken: data.leaseToken },
        );
      if (!attached) {
        throw new Error(
          'Canonical Fast web review offer lost its publish fence',
        );
      }
    }

    let autoHandledText: string | null = null;
    const ownsAutoHandleDispatch =
      directAutoHandleRoute !== null || deliveredToFastParent;
    if (
      followUp &&
      autoHandlePreference &&
      autoHandleUserId &&
      (autoHandleRoute || canAutoHandleWeb) &&
      ownsAutoHandleDispatch
    ) {
      if (
        data.deliveryState !== 'auto_dispatch_pending' &&
        !(await (canAutoHandleWeb
          ? beginCanonicalPrReviewWebAutoDispatch({
              request: data,
              followUpPrompt: followUp.prompt,
              targetTaskId: autoHandlePreference.taskId,
              actingUserId: autoHandleUserId,
            })
          : beginCanonicalPrReviewAutoDispatch({
              request: data,
              followUpPrompt: followUp.prompt,
              targetTaskId: autoHandlePreference.taskId,
              actingUserId: autoHandleUserId,
              route: autoHandleRoute!,
            })))
      ) {
        console.log(
          `[PrReviewNotification] Canonical delivery ${data.deliveryId} lost its automatic-dispatch fence, skipping`,
        );
        return;
      }
      const dispatchInput = {
        taskId: autoHandlePreference.taskId,
        followUpPrompt: followUp.prompt,
        actingUserId: autoHandleUserId,
        ...(data.dispatchKey ? { idempotencyKey: data.dispatchKey } : {}),
      };
      const dispatched = await dispatchPrReviewFollowUp(
        canAutoHandleWeb
          ? {
              ...dispatchInput,
              provider: 'web',
              idempotencyKey: webAutoDispatchKey,
            }
          : {
              ...dispatchInput,
              provider: autoHandleRoute!.provider,
              ...(autoHandleRoute!.provider === 'slack'
                ? { slackTeamId: autoHandleRoute!.slackTeamId }
                : {}),
              channelId: autoHandleRoute!.channelId,
              threadId: autoHandleRoute!.threadId ?? null,
            },
      );

      if (dispatched.outcome !== 'unavailable') {
        if (
          !(await completeCanonicalPrReviewAutoDispatch({
            request: data,
            runId: dispatched.runId,
          }))
        ) {
          console.log(
            `[PrReviewNotification] Canonical delivery ${data.deliveryId} lost its completion fence after dispatch`,
          );
          return;
        }
        autoHandledText = `New review feedback — I'm on it:
${delivery.text}`;
        console.log(
          `[PrReviewNotification] Auto-dispatched review feedback for ${data.repository}#${data.prNumber} into task ${autoHandlePreference.taskId} (${dispatched.outcome}, run ${dispatched.runId})`,
        );
      } else {
        if (data.deferrals < PR_REVIEW_NOTIFICATION_MAX_DEFERRALS) {
          await schedulePrReviewNotificationJob({
            request: {
              ...data,
              deferrals: data.deferrals + 1,
            },
            delayMs: PR_REVIEW_NOTIFICATION_DEFER_MS,
          });
          console.log(
            `[PrReviewNotification] Auto-handle dispatch unavailable for ${data.repository}#${data.prNumber}; deferred delivery while task ${data.taskId} becomes resumable (deferral ${data.deferrals + 1})`,
          );
          return;
        }

        console.warn(
          `[PrReviewNotification] Auto-handle dispatch remained unavailable for ${data.repository}#${data.prNumber} after ${data.deferrals} deferrals; falling back to the interactive offer`,
        );
        if (
          canAutoHandleWeb &&
          data.ownershipVersion === 'canonical' &&
          data.deliveryId
        ) {
          if (
            !(await releaseCanonicalPrReviewWebAutoDispatch(data)) ||
            !(await beginCanonicalPrReviewWebPrompt({
              request: data,
              followUpPrompt: followUp.prompt,
            }))
          ) {
            console.log(
              `[PrReviewNotification] Canonical Fast web delivery ${data.deliveryId} lost its interactive-fallback fence, skipping`,
            );
            return;
          }
          const fallbackDelivered = await notifyFastParent({
            includeSuggestedAction: true,
            reviewActionDeliveryId: data.deliveryId,
          });
          if (!fallbackDelivered) {
            throw new Error(
              'Canonical Fast web review fallback was not delivered',
            );
          }
          const { attached } =
            await attachPendingPrReviewActionMessageWithRetirement(
              data.deliveryId,
              data.deliveryId,
              { leaseToken: data.leaseToken },
            );
          if (!attached) {
            throw new Error(
              'Canonical Fast web review fallback lost its publish fence',
            );
          }
          await recordPrReviewNotificationDeliveryBestEffort({
            runId: latestJob.id,
            taskId: data.taskId,
            route: null,
            text: textWithQuestion,
          });
          return;
        }
      }
    }

    if (deliveredToFastParent && (!autoHandleUserId || autoHandledText)) {
      await recordPrReviewNotificationDeliveryBestEffort({
        runId: latestJob.id,
        taskId: data.taskId,
        route: null,
        text: autoHandledText ?? textWithQuestion,
      });
      if (!webReviewActionDeliveryId) {
        await finalizePrReviewNotificationRequest(data);
      }
      return;
    }

    // Once retries are exhausted, continue into the normal offer path even
    // though the Fast parent already received the deduplicated summary.

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
    let taskReviewActionDeliveryId: string | null = null;
    if (delivery.route) {
      if (
        followUp &&
        isButtonRouteProvider(delivery.route.provider) &&
        !(await beginCanonicalPrReviewPrompt({
          request: data,
          route: delivery.route,
          followUpPrompt: followUp.prompt,
        }))
      ) {
        console.log(
          `[PrReviewNotification] Canonical delivery ${data.deliveryId} lost its prompt-posting fence, skipping`,
        );
        return;
      }
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
        ...(data.ownershipVersion === 'canonical' && data.deliveryId
          ? {
              canonicalDeliveryId: data.deliveryId,
              canonicalLeaseToken: data.leaseToken,
            }
          : {}),
      });
      if (
        followUp &&
        isButtonRouteProvider(delivery.route.provider) &&
        data.ownershipVersion === 'canonical' &&
        !messageTs
      ) {
        throw new Error(
          'Canonical PR review prompt did not return a message id',
        );
      }
    } else {
      if (
        followUp &&
        !fastParent &&
        data.ownershipVersion === 'canonical' &&
        data.deliveryId
      ) {
        if (
          !(await beginCanonicalPrReviewWebPrompt({
            request: data,
            followUpPrompt: followUp.prompt,
          }))
        ) {
          console.log(
            `[PrReviewNotification] Canonical web task delivery ${data.deliveryId} lost its prompt-posting fence, skipping`,
          );
          return;
        }
        taskReviewActionDeliveryId = data.deliveryId;
      }
      console.log(
        `[PrReviewNotification] No conversation routing for task ${data.taskId}; recording review feedback to task history only`,
      );
    }
    const recorded = await recordPrReviewNotificationDeliveryBestEffort({
      runId: latestJob.id,
      taskId: data.taskId,
      route: delivery.route,
      text: textWithQuestion,
      ...(messageTs ? { messageTs } : {}),
      ...(taskReviewActionDeliveryId && followUp
        ? {
            reviewAction: {
              deliveryId: taskReviewActionDeliveryId,
              question: followUp.question,
            },
          }
        : {}),
    });
    if (taskReviewActionDeliveryId) {
      if (!recorded) {
        throw new Error('Canonical web task review offer was not persisted');
      }
      const { attached } =
        await attachPendingPrReviewActionMessageWithRetirement(
          taskReviewActionDeliveryId,
          taskReviewActionDeliveryId,
          { leaseToken: data.leaseToken },
        );
      if (!attached) {
        throw new Error(
          'Canonical web task review offer lost its publish fence',
        );
      }
    }
    if (
      data.ownershipVersion !== 'canonical' ||
      !followUp ||
      (delivery.route
        ? !isButtonRouteProvider(delivery.route.provider)
        : !taskReviewActionDeliveryId)
    ) {
      await finalizePrReviewNotificationRequest(data);
    }

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

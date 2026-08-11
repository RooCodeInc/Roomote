import { randomUUID } from 'node:crypto';

import { Job } from 'bullmq';

import type { CommunicationPostMessageInput } from '@roomote/communication';
import {
  and,
  db,
  desc,
  eq,
  getPrReviewAggregateDelivery,
  markPrReviewDeliveriesEligible,
  PR_REVIEW_DELIVERY_ALERT_AFTER_MS,
  PR_REVIEW_DELIVERY_MAX_ATTEMPTS,
  PR_REVIEW_DELIVERY_RETRY_DELAYS_MS,
  slackInstallations,
  taskPullRequests,
  taskRuns,
  updatePrReviewAggregateTriage,
  updatePrReviewDelivery,
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
  discardPendingPrReviewAction,
  preparePrReviewNotificationDelivery,
  prReviewActivityEventSchema,
  prReviewNotificationRequestSchema,
  recordPrReviewNotificationDeliveryBestEffort,
  recordTaskMessageEnvelope,
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
  ACP_ENVELOPE_EVENT_TYPES,
  isTaskExecutingTurn,
  PR_REVIEW_NOTIFICATION_TASK_MESSAGE_SOURCE,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
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

class PrReviewTransportUnavailableError extends Error {}

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
  captureProviderMessageId = false,
  aggregateId,
}: {
  taskId: string;
  route: PrReviewNotificationRoute;
  text: string;
  /** When set (button-capable routes only), post the action buttons. */
  action?: PrReviewNotificationAction;
  captureProviderMessageId?: boolean;
  aggregateId?: string;
}): Promise<string | null> {
  let slack: SlackNotifier | null = null;
  let adapter: Awaited<ReturnType<typeof getCommunicationProviderAdapter>> =
    null;

  try {
    if (route.provider === 'slack') {
      const slackInstallation = await db.query.slackInstallations.findFirst({
        where: eq(slackInstallations.isActive, true),
        columns: { botAccessToken: true },
      });

      if (!slackInstallation?.botAccessToken) {
        throw new PrReviewTransportUnavailableError('Slack is not connected.');
      }

      slack = new SlackNotifier(slackInstallation.botAccessToken);
    } else {
      adapter = await getCommunicationProviderAdapter(route.provider);

      if (!adapter) {
        throw new PrReviewTransportUnavailableError(
          `${route.provider} is not connected.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof PrReviewTransportUnavailableError) {
      throw error;
    }
    throw new PrReviewTransportUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }

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
      durableBacked: Boolean(aggregateId),
    });
    if (aggregateId) {
      await updatePrReviewDelivery({
        aggregateId,
        destination: 'chat',
        state: 'sending',
        actionNonce: nonce,
        actionHandledAt: null,
      });
    }
  }

  if (route.provider === 'slack') {
    if (!slack) {
      throw new PrReviewTransportUnavailableError('Slack is not connected.');
    }

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

  if (!adapter) {
    throw new PrReviewTransportUnavailableError(
      `${route.provider} is not connected.`,
    );
  }

  const postInput = buildPrReviewNotificationPostInput(route, text);

  if (action && nonce && isButtonRouteProvider(route.provider)) {
    postInput.buttons = buildPrReviewActionButtons(action, nonce);
  }

  const posted = await adapter.postMessage(postInput);

  if (nonce && posted?.messageId) {
    await attachPendingPrReviewActionMessage(nonce, posted.messageId);
  }

  return captureProviderMessageId ? (posted?.messageId ?? null) : null;
}

function buildPrReviewActionButtons(
  action: PrReviewNotificationAction,
  nonce: string,
) {
  return [
    [
      {
        text: 'Fix this review',
        callbackData: buildPrReviewActionCallbackData('yes', nonce),
      },
      {
        text: 'Fix all PR feedback',
        callbackData: buildPrReviewActionCallbackData('fix_all', nonce),
      },
      {
        text: 'Auto-fix future feedback',
        callbackData: buildPrReviewActionCallbackData('auto', nonce),
      },
      {
        text: 'Dismiss',
        callbackData: buildPrReviewActionCallbackData('dismiss', nonce),
      },
    ],
  ];
}

async function updatePostedPrReviewNotification(input: {
  aggregateId: string;
  taskId: string;
  route: PrReviewNotificationRoute;
  messageId: string;
  text: string;
  action?: PrReviewNotificationAction;
  previousActionNonce?: string | null;
}): Promise<void> {
  const nonce = input.action ? randomUUID() : null;

  if (input.action && nonce && isButtonRouteProvider(input.route.provider)) {
    await setPendingPrReviewAction({
      nonce,
      provider: input.route.provider,
      taskId: input.taskId,
      repository: input.action.repository,
      prNumber: input.action.prNumber,
      prUrl: input.action.prUrl,
      channelId: input.route.channelId,
      threadId: input.route.threadId ?? null,
      followUpPrompt: input.action.followUpPrompt,
      durableBacked: true,
    });
    await updatePrReviewDelivery({
      aggregateId: input.aggregateId,
      destination: 'chat',
      state: 'sending',
      actionNonce: nonce,
      previousActionNonce:
        input.previousActionNonce && input.previousActionNonce !== nonce
          ? input.previousActionNonce
          : null,
      previousActionRetiredAt: null,
      actionHandledAt: null,
    });
  }

  try {
    if (input.route.provider === 'slack') {
      const installation = await db.query.slackInstallations.findFirst({
        where: eq(slackInstallations.isActive, true),
        columns: { botAccessToken: true },
      });
      if (!installation?.botAccessToken) {
        throw new Error('Slack is not connected.');
      }
      const slack = new SlackNotifier(installation.botAccessToken);
      const updated = await slack.updateMessage({
        channel: input.route.channelId,
        ts: input.messageId,
        message: {
          text: input.text,
          ...(input.action && nonce
            ? {
                blocks: buildSlackPrReviewActionBlocks({
                  text: input.action.summaryText,
                  question: input.action.question,
                  nonce,
                }),
              }
            : {}),
        },
      });
      if (!updated) {
        throw new Error('Slack message update failed.');
      }
    } else {
      const adapter = await getCommunicationProviderAdapter(
        input.route.provider,
      );
      if (!adapter?.updateMessage) {
        throw new Error(
          `${input.route.provider} message updates are unavailable.`,
        );
      }
      await adapter.updateMessage({
        channelId: input.route.channelId,
        messageId: input.messageId,
        text: input.text,
        ...('serviceUrl' in input.route
          ? { serviceUrl: input.route.serviceUrl }
          : {}),
        textFormat: 'markdown',
        ...(input.action && nonce && isButtonRouteProvider(input.route.provider)
          ? { buttons: buildPrReviewActionButtons(input.action, nonce) }
          : {}),
      });
    }
  } catch (error) {
    if (nonce) {
      await discardPendingPrReviewAction(nonce).catch(() => undefined);
      await updatePrReviewDelivery({
        aggregateId: input.aggregateId,
        destination: 'chat',
        state: 'sending',
        actionNonce: input.previousActionNonce ?? null,
        previousActionNonce: null,
        previousActionRetiredAt: null,
        actionHandledAt: null,
      });
    }
    throw error;
  }

  if (nonce) {
    await attachPendingPrReviewActionMessage(nonce, input.messageId);
  }
  if (nonce || input.previousActionNonce) {
    await updatePrReviewDelivery({
      aggregateId: input.aggregateId,
      destination: 'chat',
      state: 'sending',
      actionNonce: nonce,
      previousActionNonce: input.previousActionNonce ?? null,
      previousActionRetiredAt: input.previousActionNonce ? new Date() : null,
      actionHandledAt: null,
    });
  }
  if (input.previousActionNonce && input.previousActionNonce !== nonce) {
    await discardPendingPrReviewAction(input.previousActionNonce);
  }
}

function getAggregateTaskMessageTs(input: {
  createdAt: Date;
  aggregateId: string;
}): number {
  const suffix = Number.parseInt(
    input.aggregateId.replaceAll('-', '').slice(-3),
    16,
  );
  return (
    input.createdAt.getTime() * 1000 + (Number.isFinite(suffix) ? suffix : 0)
  );
}

function getNextDeliveryFailure(input: {
  attemptCount: number;
  now: Date;
  eligibleAt: Date;
}): {
  state: 'failed' | 'dead_letter';
  attemptCount: number;
  nextAttemptAt: Date | null;
} {
  const attemptCount = input.attemptCount + 1;
  if (attemptCount >= PR_REVIEW_DELIVERY_MAX_ATTEMPTS) {
    return { state: 'dead_letter', attemptCount, nextAttemptAt: null };
  }
  const delay = PR_REVIEW_DELIVERY_RETRY_DELAYS_MS[attemptCount] ?? 0;
  const absoluteDeadline = input.eligibleAt.getTime() + delay;
  return {
    state: 'failed',
    attemptCount,
    nextAttemptAt: new Date(
      Math.max(input.now.getTime() + 1_000, absoluteDeadline),
    ),
  };
}

async function deliverDurablePrReviewNotification(
  data: PrReviewNotificationRequest & { aggregateId: string },
): Promise<void> {
  const loaded = await getPrReviewAggregateDelivery(data.aggregateId);
  if (!loaded) {
    return;
  }
  const { aggregate } = loaded;
  const latestJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, aggregate.taskId),
    orderBy: [desc(taskRuns.createdAt)],
  });
  if (!latestJob) {
    return;
  }

  const isExecuting = isTaskExecutingTurn(
    latestJob.status,
    latestJob.taskPhase,
  );
  const staleHeartbeat =
    latestJob.workerHeartbeatAt != null &&
    Date.now() - latestJob.workerHeartbeatAt.getTime() >=
      WORKER_HEARTBEAT_STALE_MS;
  if (isExecuting && !staleHeartbeat) {
    return;
  }

  const prLink = await db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.taskId, aggregate.taskId),
      eq(
        taskPullRequests.sourceControlProvider,
        aggregate.sourceControlProvider,
      ),
      eq(taskPullRequests.repository, aggregate.repository),
      eq(taskPullRequests.prNumber, aggregate.prNumber),
    ),
    columns: { status: true, autoHandleFeedbackByUserId: true },
  });
  if (prLink?.status === 'merged' || prLink?.status === 'closed') {
    await Promise.all([
      updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: 'task_history',
        state: 'skipped',
      }),
      updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: 'chat',
        state: 'skipped',
      }),
    ]);
    return;
  }

  await markPrReviewDeliveriesEligible(aggregate.id);
  const refreshed = await getPrReviewAggregateDelivery(aggregate.id);
  if (!refreshed) return;
  const events = refreshed.aggregate.events
    .map((event) => prReviewActivityEventSchema.safeParse(event))
    .filter((result) => result.success)
    .map((result) => result.data);
  if (events.length === 0) return;

  const request: PrReviewNotificationRequest = {
    taskId: aggregate.taskId,
    repository: aggregate.repository,
    prNumber: aggregate.prNumber,
    prUrl: aggregate.prUrl,
    deferrals: 0,
    sourceControlProvider: aggregate.sourceControlProvider,
  };
  const prepared = await preparePrReviewNotificationDelivery({
    taskRun: latestJob,
    request,
    events,
  });
  if (!prepared.post) {
    await Promise.all([
      updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: 'task_history',
        state: 'skipped',
      }),
      updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: 'chat',
        state: 'skipped',
      }),
    ]);
    return;
  }

  const triageStored = await updatePrReviewAggregateTriage({
    aggregateId: aggregate.id,
    expectedVersion: aggregate.version,
    summary: prepared.text,
    followUpQuestion: prepared.followUpQuestion,
    followUpPrompt: prepared.followUpPrompt,
  });
  if (!triageStored) {
    return;
  }

  const followUp =
    prepared.followUpQuestion && prepared.followUpPrompt
      ? {
          question: prepared.followUpQuestion,
          prompt: prepared.followUpPrompt,
        }
      : null;
  const text = followUp
    ? `${prepared.text}\n${followUp.question}`
    : prepared.text;
  const action = followUp
    ? {
        summaryText: prepared.text,
        question: followUp.question,
        followUpPrompt: followUp.prompt,
        repository: aggregate.repository,
        prNumber: aggregate.prNumber,
        prUrl: aggregate.prUrl,
      }
    : undefined;

  const current = await getPrReviewAggregateDelivery(aggregate.id);
  if (!current) return;
  const now = new Date();
  for (const delivery of current.deliveries) {
    if (
      delivery.state === 'delivered' &&
      delivery.aggregateVersion >= aggregate.version
    ) {
      continue;
    }
    if (
      delivery.destination === 'chat' &&
      delivery.state === 'sending' &&
      !delivery.chatMessageId
    ) {
      console.error(
        `[PrReviewNotification] Initial chat delivery outcome is unknown for task ${aggregate.taskId} ${aggregate.repository}#${aggregate.prNumber}`,
      );
      await updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: 'chat',
        state: 'unknown',
        nextAttemptAt: null,
        lastError: 'Initial provider send did not reach a durable result.',
        alertEmittedAt: now,
      });
      continue;
    }
    if (
      delivery.eligibleAt &&
      !delivery.alertEmittedAt &&
      now.getTime() - delivery.eligibleAt.getTime() >=
        PR_REVIEW_DELIVERY_ALERT_AFTER_MS
    ) {
      console.error(
        `[PrReviewNotification] Delivery SLO breached for task ${aggregate.taskId} ${aggregate.repository}#${aggregate.prNumber} destination=${delivery.destination}`,
      );
      await updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: delivery.destination,
        state: delivery.state,
        alertEmittedAt: now,
      });
    }

    if (delivery.destination === 'task_history') {
      try {
        await recordTaskMessageEnvelope({
          runId: latestJob.id,
          taskId: aggregate.taskId,
          envelope: {
            ts: getAggregateTaskMessageTs({
              createdAt: aggregate.createdAt,
              aggregateId: aggregate.id,
            }),
            eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            role: 'assistant',
            protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
            contentBlocks: [{ type: 'text', text }],
            metadata: {
              source: PR_REVIEW_NOTIFICATION_TASK_MESSAGE_SOURCE,
              visibleInTranscript: true,
            },
            payload: {
              text,
              source: PR_REVIEW_NOTIFICATION_TASK_MESSAGE_SOURCE,
            },
            visibleInTranscript: true,
          },
        });
        await updatePrReviewDelivery({
          aggregateId: aggregate.id,
          destination: 'task_history',
          state: 'delivered',
          aggregateVersion: aggregate.version,
          attemptCount: delivery.attemptCount + 1,
          nextAttemptAt: null,
          lastError: null,
          deliveredAt: now,
        });
      } catch (error) {
        const failure = getNextDeliveryFailure({
          attemptCount: delivery.attemptCount,
          now,
          eligibleAt: delivery.eligibleAt ?? now,
        });
        await updatePrReviewDelivery({
          aggregateId: aggregate.id,
          destination: 'task_history',
          ...failure,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    if (!prepared.route) {
      await updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: 'chat',
        state: 'skipped',
        aggregateVersion: aggregate.version,
      });
      continue;
    }

    if (delivery.chatMessageId) {
      try {
        await updatePostedPrReviewNotification({
          aggregateId: aggregate.id,
          taskId: aggregate.taskId,
          route: prepared.route,
          messageId: delivery.chatMessageId,
          text,
          action:
            action && isButtonRouteProvider(prepared.route.provider)
              ? action
              : undefined,
          previousActionNonce:
            delivery.previousActionNonce && !delivery.previousActionRetiredAt
              ? delivery.previousActionNonce
              : delivery.actionNonce,
        });
        await updatePrReviewDelivery({
          aggregateId: aggregate.id,
          destination: 'chat',
          state: 'delivered',
          aggregateVersion: aggregate.version,
          attemptCount: delivery.attemptCount + 1,
          nextAttemptAt: null,
          lastError: null,
          deliveredAt: now,
        });
      } catch (error) {
        const failure = getNextDeliveryFailure({
          attemptCount: delivery.attemptCount,
          now,
          eligibleAt: delivery.eligibleAt ?? now,
        });
        await updatePrReviewDelivery({
          aggregateId: aggregate.id,
          destination: 'chat',
          ...failure,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    await updatePrReviewDelivery({
      aggregateId: aggregate.id,
      destination: 'chat',
      state: 'sending',
      attemptCount: delivery.attemptCount + 1,
      chatProvider: prepared.route.provider,
      chatChannelId: prepared.route.channelId,
      chatThreadId: prepared.route.threadId ?? null,
      chatServiceUrl:
        'serviceUrl' in prepared.route ? prepared.route.serviceUrl : null,
    });
    try {
      const messageId = await postPrReviewNotification({
        taskId: aggregate.taskId,
        route: prepared.route,
        text,
        action:
          action && isButtonRouteProvider(prepared.route.provider)
            ? action
            : undefined,
        captureProviderMessageId: true,
        aggregateId: aggregate.id,
      });
      if (!messageId) {
        await updatePrReviewDelivery({
          aggregateId: aggregate.id,
          destination: 'chat',
          state: 'unknown',
          nextAttemptAt: null,
          lastError: 'Provider response did not include a message id.',
          alertEmittedAt: now,
        });
        continue;
      }
      await updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: 'chat',
        state: 'delivered',
        aggregateVersion: aggregate.version,
        attemptCount: delivery.attemptCount + 1,
        nextAttemptAt: null,
        lastError: null,
        chatMessageId: messageId,
        deliveredAt: now,
      });
    } catch (error) {
      if (error instanceof PrReviewTransportUnavailableError) {
        const failure = getNextDeliveryFailure({
          attemptCount: delivery.attemptCount,
          now,
          eligibleAt: delivery.eligibleAt ?? now,
        });
        await updatePrReviewDelivery({
          aggregateId: aggregate.id,
          destination: 'chat',
          ...failure,
          lastError: error.message,
        });
        continue;
      }
      // The provider may have accepted the post before the response was lost.
      // At-most-once policy: never retry an ambiguous initial send.
      console.error(
        `[PrReviewNotification] Ambiguous initial chat delivery for task ${aggregate.taskId} ${aggregate.repository}#${aggregate.prNumber}`,
        error,
      );
      await updatePrReviewDelivery({
        aggregateId: aggregate.id,
        destination: 'chat',
        state: 'unknown',
        nextAttemptAt: null,
        lastError: error instanceof Error ? error.message : String(error),
        alertEmittedAt: now,
      });
    }
  }
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
  if (data.aggregateId) {
    await deliverDurablePrReviewNotification({
      ...data,
      aggregateId: data.aggregateId,
    });
    return;
  }
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
      `[PrReviewNotification] Task ${data.taskId} never went idle after ${data.deferrals} deferrals, dropping pending review activity for ${data.repository}#${data.prNumber}`,
    );
    await consumePendingPrReviewActivity(target);
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
        taskId: data.taskId,
        repository: data.repository,
        prNumber: data.prNumber,
        action: 'auto',
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

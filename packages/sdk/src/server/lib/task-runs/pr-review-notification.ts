import { Queue } from 'bullmq';
import { z } from 'zod';

import type { TaskRun } from '@roomote/db/server';
import {
  buildPrReviewEventKey,
  claimDuePrReviewDeliveries,
  completePrReviewDeliveries,
  deferPrReviewDeliveries,
  persistPrReviewEvent,
  recordPrReviewCycleState,
  releasePrReviewDeliveries,
  renewPrReviewDeliveryClaim,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  type CommunicationProvider,
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  sourceControlProviderSchema,
} from '@roomote/types';

import { resolveSlackTaskRunRouting } from './slack-task-run-routing';

export const PR_REVIEW_NOTIFICATION_QUEUE_NAME = 'pr-review-notification-jobs';

/**
 * Debounce window for ordinary PR review activity so related review comments
 * collapse into one notification.
 */
export const PR_REVIEW_NOTIFICATION_DEBOUNCE_MS = 1 * 60 * 1000;

/**
 * Roomote's own inline findings are provisional until its review summary
 * completes. Keep them as a fallback instead of presenting them as a second
 * notification while the review is still running.
 */
export const PR_REVIEW_NOTIFICATION_ROOMOTE_FALLBACK_MS = 15 * 60 * 1000;

/**
 * Delay before re-checking an owner task that is still actively running when
 * the notification job fires. The notification is intentionally held until
 * the task goes idle.
 */
export const PR_REVIEW_NOTIFICATION_DEFER_MS = 5 * 60 * 1000;

/**
 * Upper bound on idle-wait deferrals. The notification only posts while the
 * owning task is idle, so once the cap is reached the pending feedback is
 * dropped instead of being posted mid-run. At the 5-minute recheck interval
 * this cap roughly matches the 24-hour pending-events TTL, so it mainly
 * protects against tasks stuck in a running state scheduling deferral jobs
 * forever.
 */
export const PR_REVIEW_NOTIFICATION_MAX_DEFERRALS = 288;

const prReviewNotificationBatchKindSchema = z.enum(['human', 'roomote']);

const prReviewCycleStateSchema = z.object({
  cycleId: z.string(),
  phase: z.enum(['open', 'completed']),
  observedAt: z.number(),
});

export const prReviewActivityEventSchema = z.object({
  kind: z.enum(['issue_comment', 'review', 'review_comment', 'review_summary']),
  authorLogin: z.string(),
  /** Commit SHA reviewed by this event. */
  reviewHeadSha: z.string().optional(),
  /**
   * Stable feedback-batch identity. Human review events use GitHub's review
   * id; Roomote events use the explicit lifecycle opened by its in-progress
   * summary comment. This prevents separate passes on the same SHA from being
   * conflated.
   */
  batchId: z.string().optional(),
  /** GitHub review state for `review` events, e.g. `approved`. */
  reviewState: z.string().optional(),
  /** Short human-readable summary text for `review_summary` events. */
  summary: z.string().optional(),
  /** HTML URL of the review or comment the event describes, when known. */
  url: z.string().optional(),
  /** Provider event time used to order review lifecycle transitions. */
  observedAt: z.number().int().nonnegative().optional(),
  /**
   * True when the event was authored by Roomote's own GitHub identity (for
   * example results of the agent's own automated PR review), so the
   * notification can describe the feedback in the first person.
   */
  roomoteAuthored: z.boolean().optional(),
  /** Provider-stable webhook object id used for durable ingestion dedupe. */
  providerEventId: z.string().optional(),
});

export type PrReviewActivityEvent = z.infer<typeof prReviewActivityEventSchema>;

export const prReviewNotificationRequestSchema = z.object({
  taskId: z.string(),
  repository: z.string(),
  prNumber: z.number().int().positive(),
  prUrl: z.string(),
  deferrals: z.number().int().min(0).default(0),
  immediate: z.boolean().optional(),
  batchKind: prReviewNotificationBatchKindSchema.optional(),
  batchId: z.string().optional(),
  sourceControlProvider: sourceControlProviderSchema.optional(),
  deliveryIds: z.array(z.string()).optional(),
  leaseToken: z.string().optional(),
  events: z.array(prReviewActivityEventSchema).optional(),
});

export type PrReviewNotificationRequest = z.infer<
  typeof prReviewNotificationRequestSchema
>;

type PrReviewNotificationTarget = {
  taskId: string;
  repository: string;
  prNumber: number;
  immediate?: boolean;
  batchKind?: z.infer<typeof prReviewNotificationBatchKindSchema>;
  batchId?: string;
  deliveryIds?: string[];
  leaseToken?: string;
  events?: PrReviewActivityEvent[];
};

export const startPrReviewNotificationCycleInputSchema = z.object({
  repository: z.string(),
  prNumber: z.number().int().positive(),
  reviewHeadSha: z.string(),
  cycleId: z.string(),
  observedAt: z.number().int().nonnegative(),
});

export type StartPrReviewNotificationCycleInput = z.infer<
  typeof startPrReviewNotificationCycleInputSchema
>;

export const enqueuePrReviewNotificationInputSchema = z.object({
  repository: z.string(),
  prNumber: z.number().int().positive(),
  prUrl: z.string(),
  event: prReviewActivityEventSchema,
  sourceControlProvider: sourceControlProviderSchema.optional(),
});

export type EnqueuePrReviewNotificationInput = z.infer<
  typeof enqueuePrReviewNotificationInputSchema
>;

type EnqueuePrReviewNotificationResult = {
  notifiedTaskCount: number;
  reason?: string;
};

type PrReviewNotificationRoutingRun = Pick<
  TaskRun,
  'id' | 'taskId' | 'payload'
>;

export type PrReviewNotificationRoute =
  | { provider: 'slack'; channelId: string; threadId: string }
  | {
      provider: 'teams';
      channelId: string;
      threadId: string | null;
      serviceUrl: string;
    }
  | { provider: 'telegram'; channelId: string; threadId: string | null }
  | { provider: 'discord'; channelId: string; threadId: string | null };

let prReviewNotificationQueue: Queue<PrReviewNotificationRequest> | null = null;

function getPrReviewNotificationQueue(): Queue<PrReviewNotificationRequest> {
  if (!prReviewNotificationQueue) {
    const redis = getRedis();

    prReviewNotificationQueue = new Queue<PrReviewNotificationRequest>(
      PR_REVIEW_NOTIFICATION_QUEUE_NAME,
      {
        connection: redis,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 100 },
          removeOnFail: { age: 24 * 3600 },
        },
      },
    );
  }

  return prReviewNotificationQueue;
}

function buildTargetKeySuffix({
  taskId,
  repository,
  prNumber,
  batchKind = 'human',
  batchId,
}: PrReviewNotificationTarget): string {
  return `${encodeURIComponent(taskId)}:${encodeURIComponent(repository)}#${prNumber}:${batchKind}${batchId ? `:${encodeURIComponent(batchId)}` : ''}`;
}

function buildLegacyTargetKeySuffix({
  taskId,
  repository,
  prNumber,
  immediate = false,
}: PrReviewNotificationTarget): string {
  return `${encodeURIComponent(taskId)}:${encodeURIComponent(repository)}#${prNumber}${immediate ? ':immediate' : ''}`;
}

function buildPendingEventsKey(target: PrReviewNotificationTarget): string {
  if (target.batchKind === undefined) {
    return `pr-review-notification:pending:${buildLegacyTargetKeySuffix(target)}`;
  }

  return `pr-review-notification:pending:${buildTargetKeySuffix(target)}`;
}

function getPrReviewLatestCompletedCycleKey({
  repository,
  prNumber,
  reviewHeadSha,
}: {
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
}): string {
  return `pr-review-notification:review-cycle-latest-completed:${encodeURIComponent(repository)}#${prNumber}:${reviewHeadSha}`;
}

function getLegacyPrReviewCycleStateKey({
  repository,
  prNumber,
  reviewHeadSha,
}: {
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
}): string {
  return `pr-review-notification:review-cycle:${encodeURIComponent(repository)}#${prNumber}:${reviewHeadSha}`;
}

/** Records the start of a concrete Roomote review pass. */
export async function startPrReviewNotificationCycle(
  input: StartPrReviewNotificationCycleInput,
): Promise<void> {
  const parsed = startPrReviewNotificationCycleInputSchema.parse(input);
  await recordPrReviewCycleState({
    sourceControlProvider: 'github',
    repository: parsed.repository,
    prNumber: parsed.prNumber,
    reviewHeadSha: parsed.reviewHeadSha,
    cycleId: parsed.cycleId,
    phase: 'open',
    observedAt: new Date(parsed.observedAt),
  });
}

/**
 * Returns whether the given run carries originating-conversation context for
 * any supported communication provider. The Slack thread binding lives on the
 * tasks row; callers pass it alongside the run payload.
 */
export function hasPrReviewNotificationThreadContext(job: {
  payload: unknown;
  slackThreadTs: string | null;
}): boolean {
  if (job.slackThreadTs) {
    return true;
  }

  return Boolean(
    getCommunicationProviderFromTaskPayload(job.payload) &&
    getCommunicationChannelFromTaskPayload(job.payload),
  );
}

/**
 * Resolves the originating conversation for a task run across communication
 * providers. Slack payloads (including legacy field shapes) resolve through
 * the snapshot-resume source-run chain; Teams and Telegram resolve from the
 * provider-neutral communication payload fields, which are copied forward
 * onto resume-run payloads.
 */
export async function resolvePrReviewNotificationRoute(
  job: PrReviewNotificationRoutingRun,
): Promise<PrReviewNotificationRoute | null> {
  const provider = getCommunicationProviderFromTaskPayload(job.payload);

  if (provider === 'teams') {
    const channelId = getCommunicationChannelFromTaskPayload(job.payload);
    const serviceUrl = getCommunicationServiceUrlFromTaskPayload(job.payload);

    if (!channelId || !serviceUrl) {
      return null;
    }

    return {
      provider,
      channelId,
      serviceUrl,
      threadId: getCommunicationThreadIdFromTaskPayload(job.payload),
    };
  }

  if (provider === 'telegram') {
    const channelId = getCommunicationChannelFromTaskPayload(job.payload);

    if (!channelId) {
      return null;
    }

    return {
      provider,
      channelId,
      threadId: getCommunicationThreadIdFromTaskPayload(job.payload),
    };
  }

  if (provider === 'discord') {
    const channelId = getCommunicationChannelFromTaskPayload(job.payload);
    if (!channelId) return null;
    return {
      provider,
      channelId,
      threadId: getCommunicationThreadIdFromTaskPayload(job.payload),
    };
  }

  const { channel, threadTs } = await resolveSlackTaskRunRouting(job);

  if (!channel || !threadTs) {
    return null;
  }

  return { provider: 'slack', channelId: channel, threadId: threadTs };
}

/** Moves an owned database delivery back to pending with a later due time. */
export async function schedulePrReviewNotificationJob({
  request,
  delayMs,
}: {
  request: PrReviewNotificationRequest;
  delayMs: number;
}): Promise<void> {
  if (!request.deliveryIds || !request.leaseToken) {
    throw new Error('Cannot defer a PR review notification without a lease');
  }

  await deferPrReviewDeliveries(
    { deliveryIds: request.deliveryIds, leaseToken: request.leaseToken },
    new Date(Date.now() + delayMs),
  );
}

export async function consumePendingPrReviewActivity(
  target: PrReviewNotificationTarget,
): Promise<PrReviewActivityEvent[]> {
  if (!target.deliveryIds || !target.leaseToken || !target.events) {
    throw new Error('Cannot consume a PR review notification without a lease');
  }

  return target.events;
}

export async function requeuePendingPrReviewActivity({
  target,
}: {
  target: PrReviewNotificationTarget;
  events: PrReviewActivityEvent[];
}): Promise<void> {
  if (!target.deliveryIds || !target.leaseToken) {
    throw new Error('Cannot release a PR review notification without a lease');
  }

  await releasePrReviewDeliveries({
    deliveryIds: target.deliveryIds,
    leaseToken: target.leaseToken,
  });
}

export function isDurablePrReviewNotificationRequest(
  request: PrReviewNotificationRequest,
): boolean {
  return Boolean(
    request.deliveryIds?.length && request.leaseToken && request.events,
  );
}

/**
 * N-1 upgrade path for jobs queued before Postgres became authoritative.
 * Legacy Redis is read only. Cycle state is materialized first, then each
 * pending event is deterministically inserted into the normal database path.
 */
export async function migrateLegacyPrReviewNotificationRequest(
  request: PrReviewNotificationRequest,
): Promise<number> {
  if (isDurablePrReviewNotificationRequest(request)) return 0;

  const redis = getRedis();
  const rawEvents = await redis.lrange(buildPendingEventsKey(request), 0, -1);
  const events = rawEvents.flatMap((raw) => {
    try {
      const parsed = prReviewActivityEventSchema.safeParse(JSON.parse(raw));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
  const roomoteHeadShas = [
    ...new Set(
      events.flatMap((event) =>
        event.roomoteAuthored && event.reviewHeadSha
          ? [event.reviewHeadSha]
          : [],
      ),
    ),
  ];

  for (const reviewHeadSha of roomoteHeadShas) {
    const rawStates = await Promise.all([
      redis.get(
        getLegacyPrReviewCycleStateKey({
          repository: request.repository,
          prNumber: request.prNumber,
          reviewHeadSha,
        }),
      ),
      redis.get(
        getPrReviewLatestCompletedCycleKey({
          repository: request.repository,
          prNumber: request.prNumber,
          reviewHeadSha,
        }),
      ),
    ]);
    const states = rawStates.flatMap((raw) => {
      if (!raw) return [];
      try {
        const parsed = prReviewCycleStateSchema.safeParse(JSON.parse(raw));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
    const latest = states.sort((a, b) => b.observedAt - a.observedAt)[0];
    if (latest) {
      await recordPrReviewCycleState({
        sourceControlProvider: request.sourceControlProvider ?? 'github',
        repository: request.repository,
        prNumber: request.prNumber,
        reviewHeadSha,
        ...latest,
        observedAt: new Date(latest.observedAt),
      });
    }
  }

  for (const event of events) {
    const sourceControlProvider = request.sourceControlProvider ?? 'github';
    const roomoteAuthored = event.roomoteAuthored === true;
    await persistPrReviewEvent({
      eventKey: buildPrReviewEventKey({
        sourceControlProvider,
        repository: request.repository,
        prNumber: request.prNumber,
        event,
      }),
      sourceControlProvider,
      repository: request.repository,
      prNumber: request.prNumber,
      prUrl: request.prUrl,
      event,
      batchKind: roomoteAuthored ? 'roomote' : 'human',
      batchId: event.batchId ?? request.batchId ?? null,
      dueAt: new Date(),
      observedAt: new Date(event.observedAt ?? Date.now()),
      reviewHeadSha: event.reviewHeadSha ?? null,
      roomoteAuthored,
      isSummary: roomoteAuthored && event.kind === 'review_summary',
    });
  }

  await dispatchDuePrReviewNotifications();
  return events.length;
}

/**
 * Records PR review activity (submitted reviews and review comments) for the
 * tasks that own the pull request, and schedules a notification job per task.
 * Human feedback and Roomote review cycles use separate batches. A Roomote
 * summary promotes its cycle immediately, while inline findings remain a
 * delayed fallback if no summary arrives. Chat delivery still needs an
 * originating conversation route, but web-only tasks are enqueued too so the
 * summary can land in task history.
 * The notification is informational only: it tells the user about the review
 * feedback once the task is idle. No agent turn is started.
 */
export async function enqueuePrReviewNotification(
  input: EnqueuePrReviewNotificationInput,
): Promise<EnqueuePrReviewNotificationResult> {
  const parsedInput = enqueuePrReviewNotificationInputSchema.parse(input);
  const sourceControlProvider = parsedInput.sourceControlProvider ?? 'github';
  const isRoomoteEvent = parsedInput.event.roomoteAuthored === true;
  const isRoomoteSummary =
    isRoomoteEvent && parsedInput.event.kind === 'review_summary';
  const event = parsedInput.event;

  const notificationDelayMs = isRoomoteSummary
    ? 0
    : isRoomoteEvent
      ? PR_REVIEW_NOTIFICATION_ROOMOTE_FALLBACK_MS
      : PR_REVIEW_NOTIFICATION_DEBOUNCE_MS;

  const eventRecord = prReviewActivityEventSchema.parse(event);
  const result = await persistPrReviewEvent({
    eventKey: buildPrReviewEventKey({
      sourceControlProvider,
      repository: parsedInput.repository,
      prNumber: parsedInput.prNumber,
      event: eventRecord,
    }),
    sourceControlProvider,
    repository: parsedInput.repository,
    prNumber: parsedInput.prNumber,
    prUrl: parsedInput.prUrl,
    event: eventRecord,
    batchKind: isRoomoteEvent ? 'roomote' : 'human',
    batchId: event.batchId ?? null,
    dueAt: new Date(Date.now() + notificationDelayMs),
    observedAt: new Date(event.observedAt ?? Date.now()),
    reviewHeadSha: event.reviewHeadSha ?? null,
    roomoteAuthored: isRoomoteEvent,
    isSummary: isRoomoteSummary,
  });

  if (result.reason) {
    return { notifiedTaskCount: 0, reason: result.reason };
  }

  if (isRoomoteSummary) {
    await dispatchDuePrReviewNotifications().catch(() => undefined);
  }

  return result.projectedTaskCount === 0
    ? { notifiedTaskCount: 0, reason: 'no_linked_tasks' }
    : { notifiedTaskCount: result.projectedTaskCount };
}

/**
 * Claims due Postgres deliveries and uses BullMQ only as a low-latency wakeup.
 * A failed enqueue releases the lease; the next normal scheduled drain finds
 * the same durable rows without a repair index or replay chain.
 */
export async function dispatchDuePrReviewNotifications(): Promise<number> {
  const claims = await claimDuePrReviewDeliveries();
  let enqueued = 0;

  for (const claim of claims) {
    try {
      await getPrReviewNotificationQueue().add('notify-pr-review-activity', {
        taskId: claim.taskId,
        repository: claim.repository,
        prNumber: claim.prNumber,
        prUrl: claim.prUrl,
        deferrals: claim.deferrals,
        immediate: claim.batchKind === 'roomote',
        batchKind: claim.batchKind,
        ...(claim.batchId ? { batchId: claim.batchId } : {}),
        sourceControlProvider: claim.sourceControlProvider,
        deliveryIds: claim.deliveryIds,
        leaseToken: claim.leaseToken,
        events: claim.events.map((event) =>
          prReviewActivityEventSchema.parse(event),
        ),
      });
      enqueued += 1;
    } catch (error) {
      await releasePrReviewDeliveries(claim);
      console.warn(
        `[dispatchDuePrReviewNotifications] Failed to wake ${claim.repository}#${claim.prNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return enqueued;
}

export async function finalizePrReviewNotificationRequest(
  request: PrReviewNotificationRequest,
  status: 'delivered' | 'suppressed' = 'delivered',
): Promise<void> {
  if (request.deliveryIds && request.leaseToken) {
    await completePrReviewDeliveries(
      { deliveryIds: request.deliveryIds, leaseToken: request.leaseToken },
      status,
    );
  }
}

export async function renewPrReviewNotificationRequestLease(
  request: PrReviewNotificationRequest,
): Promise<boolean> {
  if (!request.deliveryIds || !request.leaseToken) return true;
  return renewPrReviewDeliveryClaim({
    deliveryIds: request.deliveryIds,
    leaseToken: request.leaseToken,
  });
}

function getPrReviewLinkFormatter(
  provider: CommunicationProvider,
): (label: string, url: string) => string {
  switch (provider) {
    case 'slack':
      return (label, url) => `<${url}|${label}>`;
    case 'teams':
      return (label, url) => `[${label}](${url})`;
    case 'telegram':
      return (label, url) => `${label} (${url})`;
    case 'discord':
      return (label, url) => `[${label}](${url})`;
  }
}

const MARKDOWN_LINK_SOURCE = String.raw`\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)`;

/**
 * Formats the notification text for aggregated PR review activity. The
 * summary (an LLM-written message that weaves markdown links to the pull
 * request or specific comments inline) is the entire message body; its
 * markdown links are converted to each provider's link syntax (Slack mrkdwn,
 * Teams Markdown, Telegram plain text). When the summary carries no link at
 * all, a link to the pull request is appended so the target stays reachable.
 */
export function formatPrReviewActivityMessage({
  repository,
  prNumber,
  prUrl,
  provider,
  summary,
}: {
  repository: string;
  prNumber: number;
  prUrl: string;
  provider: CommunicationProvider;
  summary: string;
}): string {
  const formatLink = getPrReviewLinkFormatter(provider);
  const trimmedSummary = summary.trim();
  const hasInlineLink = new RegExp(MARKDOWN_LINK_SOURCE).test(trimmedSummary);

  const text =
    provider === 'teams'
      ? trimmedSummary
      : trimmedSummary.replace(
          new RegExp(MARKDOWN_LINK_SOURCE, 'g'),
          (_match, label, url) => formatLink(label, url),
        );

  if (hasInlineLink) {
    return text;
  }

  return `${text}\n${formatLink(`${repository}#${prNumber}`, prUrl)}`;
}

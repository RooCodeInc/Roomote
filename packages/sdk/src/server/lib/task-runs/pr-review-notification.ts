import { Queue } from 'bullmq';
import { z } from 'zod';

import type { TaskRun } from '@roomote/db/server';
import { and, db, eq, taskPullRequests } from '@roomote/db/server';
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
export const PR_REVIEW_NOTIFICATION_ROOMOTE_FALLBACK_MS = 30 * 60 * 1000;

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

const PENDING_EVENTS_TTL_SECONDS = 24 * 60 * 60;
const SCHEDULED_MARKER_TTL_BUFFER_SECONDS = 15 * 60;
const REVIEW_CYCLE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SET_REVIEW_CYCLE_IF_NEWER_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  if tonumber(decoded.observedAt) > tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`;
const COMPLETE_REVIEW_CYCLE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  if decoded.cycleId ~= ARGV[1] or tonumber(decoded.observedAt) > tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[4])
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
`;
const RESTORE_REVIEW_CYCLE_IF_VALUE_MATCHES_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  if ARGV[2] == '' then
    return redis.call('DEL', KEYS[1])
  end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0
`;

const prReviewNotificationBatchKindSchema = z.enum(['human', 'roomote']);

const prReviewCycleStateSchema = z.object({
  cycleId: z.string(),
  phase: z.enum(['open', 'completed']),
  observedAt: z.number(),
});

type PrReviewCycleState = z.infer<typeof prReviewCycleStateSchema>;

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

function buildScheduledMarkerKey(target: PrReviewNotificationTarget): string {
  if (target.batchKind === undefined) {
    return `pr-review-notification:scheduled:${buildLegacyTargetKeySuffix(target)}`;
  }

  return `pr-review-notification:scheduled:${buildTargetKeySuffix(target)}:${target.immediate ? 'immediate' : 'delayed'}`;
}

function getPrReviewCycleStateKey({
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

export function getPrReviewCompletedCycleKey({
  repository,
  prNumber,
  cycleId,
}: {
  repository: string;
  prNumber: number;
  cycleId: string;
}): string {
  return `pr-review-notification:review-cycle-completed:${encodeURIComponent(repository)}#${prNumber}:${encodeURIComponent(cycleId)}`;
}

async function readPrReviewCycleState({
  repository,
  prNumber,
  reviewHeadSha,
}: {
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
}): Promise<{
  key: string;
  raw: string | null;
  state: PrReviewCycleState | null;
}> {
  const key = getPrReviewCycleStateKey({
    repository,
    prNumber,
    reviewHeadSha,
  });
  const raw = await getRedis().get(key);
  const parsed = raw
    ? prReviewCycleStateSchema.safeParse(JSON.parse(raw))
    : null;

  return {
    key,
    raw,
    state: parsed?.success ? parsed.data : null,
  };
}

/** Records the start of a concrete Roomote review pass. */
export async function startPrReviewNotificationCycle(
  input: StartPrReviewNotificationCycleInput,
): Promise<void> {
  const parsed = startPrReviewNotificationCycleInputSchema.parse(input);
  const key = getPrReviewCycleStateKey(parsed);
  const value = JSON.stringify({
    cycleId: parsed.cycleId,
    phase: 'open',
    observedAt: parsed.observedAt,
  } satisfies PrReviewCycleState);

  await getRedis().eval(
    SET_REVIEW_CYCLE_IF_NEWER_SCRIPT,
    1,
    key,
    value,
    parsed.observedAt,
    REVIEW_CYCLE_TTL_SECONDS,
  );
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

/**
 * Schedules (or re-schedules) the delayed notification job. Also refreshes the
 * scheduled marker so concurrent webhook events keep appending to the pending
 * event list instead of scheduling duplicate jobs.
 */
export async function schedulePrReviewNotificationJob({
  request,
  delayMs,
}: {
  request: PrReviewNotificationRequest;
  delayMs: number;
}): Promise<void> {
  const redis = getRedis();
  const markerKey = buildScheduledMarkerKey(request);
  const markerTtlSeconds =
    Math.ceil(delayMs / 1000) + SCHEDULED_MARKER_TTL_BUFFER_SECONDS;

  await redis.set(markerKey, '1', 'EX', markerTtlSeconds);

  try {
    await getPrReviewNotificationQueue().add(
      'notify-pr-review-activity',
      request,
      { delay: delayMs },
    );
  } catch (error) {
    await redis.del(markerKey).catch(() => undefined);
    throw error;
  }
}

/**
 * Appends a pending review-activity event for the task and returns whether
 * this call claimed responsibility for scheduling the notification job.
 */
async function appendPendingEventAndClaimSchedule({
  target,
  event,
  delayMs,
}: {
  target: PrReviewNotificationTarget;
  event: PrReviewActivityEvent;
  delayMs: number;
}): Promise<boolean> {
  const redis = getRedis();
  const pendingKey = buildPendingEventsKey(target);
  const markerKey = buildScheduledMarkerKey(target);

  await redis
    .multi()
    .rpush(pendingKey, JSON.stringify(event))
    .expire(pendingKey, PENDING_EVENTS_TTL_SECONDS)
    .exec();

  const markerTtlSeconds =
    Math.ceil(delayMs / 1000) + SCHEDULED_MARKER_TTL_BUFFER_SECONDS;

  const claim = await redis.set(markerKey, '1', 'EX', markerTtlSeconds, 'NX');

  return claim === 'OK';
}

/**
 * Atomically drains the pending review-activity events for the task and
 * clears the scheduled marker so later events schedule a fresh notification.
 */
export async function consumePendingPrReviewActivity(
  target: PrReviewNotificationTarget,
): Promise<PrReviewActivityEvent[]> {
  const redis = getRedis();
  const pendingKey = buildPendingEventsKey(target);
  const delayedMarkerKey = buildScheduledMarkerKey({
    ...target,
    immediate: false,
  });
  const immediateMarkerKey = buildScheduledMarkerKey({
    ...target,
    immediate: true,
  });

  await redis.del(delayedMarkerKey, immediateMarkerKey).catch(() => undefined);

  const results = await redis
    .multi()
    .lrange(pendingKey, 0, -1)
    .del(pendingKey)
    .exec();

  const rawEvents = results?.[0]?.[1];

  if (!Array.isArray(rawEvents)) {
    return [];
  }

  const events: PrReviewActivityEvent[] = [];

  for (const raw of rawEvents) {
    if (typeof raw !== 'string') {
      continue;
    }

    try {
      const parsed = prReviewActivityEventSchema.safeParse(JSON.parse(raw));

      if (parsed.success) {
        events.push(parsed.data);
      }
    } catch {
      // Ignore malformed entries.
    }
  }

  const roomoteBatchIds = Array.from(
    new Set(
      events.flatMap((event) =>
        event.kind !== 'review_summary' &&
        event.roomoteAuthored &&
        event.batchId
          ? [event.batchId]
          : [],
      ),
    ),
  );
  const completedBatchIds = new Set<string>();
  const roomoteHeadShas = Array.from(
    new Set(
      events.flatMap((event) =>
        event.kind !== 'review_summary' &&
        event.roomoteAuthored &&
        event.reviewHeadSha &&
        event.observedAt !== undefined
          ? [event.reviewHeadSha]
          : [],
      ),
    ),
  );
  const completedHeadObservedAt = new Map<string, number>();

  await Promise.all([
    ...roomoteBatchIds.map(async (cycleId) => {
      let completed: string | null;

      try {
        completed = await redis.get(
          getPrReviewCompletedCycleKey({
            repository: target.repository,
            prNumber: target.prNumber,
            cycleId,
          }),
        );
      } catch {
        // The pending list is already drained; fail open so feedback is not lost.
        return;
      }

      if (completed) {
        completedBatchIds.add(cycleId);
      }
    }),
    ...roomoteHeadShas.map(async (reviewHeadSha) => {
      try {
        const cycle = await readPrReviewCycleState({
          repository: target.repository,
          prNumber: target.prNumber,
          reviewHeadSha,
        });

        if (cycle.state?.phase === 'completed') {
          completedHeadObservedAt.set(reviewHeadSha, cycle.state.observedAt);
        }
      } catch {
        // The pending list is already drained; fail open so feedback is not lost.
      }
    }),
  ]);

  return events.filter((event) => {
    if (event.kind === 'review_summary' || !event.roomoteAuthored) {
      return true;
    }

    if (event.batchId && completedBatchIds.has(event.batchId)) {
      return false;
    }

    const completedAt = event.reviewHeadSha
      ? completedHeadObservedAt.get(event.reviewHeadSha)
      : undefined;

    return (
      completedAt === undefined ||
      event.observedAt === undefined ||
      event.observedAt > completedAt
    );
  });
}

/**
 * Requeues events that could not be delivered so a retried notification job
 * can pick them up again.
 */
export async function requeuePendingPrReviewActivity({
  target,
  events,
}: {
  target: PrReviewNotificationTarget;
  events: PrReviewActivityEvent[];
}): Promise<void> {
  if (events.length === 0) {
    return;
  }

  const redis = getRedis();
  const pendingKey = buildPendingEventsKey(target);

  await redis
    .multi()
    .rpush(pendingKey, ...events.map((event) => JSON.stringify(event)))
    .expire(pendingKey, PENDING_EVENTS_TTL_SECONDS)
    .exec();
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

  const prTaskLinks = await db.query.taskPullRequests.findMany({
    where: and(
      eq(
        taskPullRequests.sourceControlProvider,
        parsedInput.sourceControlProvider ?? 'github',
      ),
      eq(taskPullRequests.repository, parsedInput.repository),
      eq(taskPullRequests.prNumber, parsedInput.prNumber),
    ),
    columns: { taskId: true },
  });

  const taskIds = Array.from(new Set(prTaskLinks.map((link) => link.taskId)));

  if (taskIds.length === 0) {
    return { notifiedTaskCount: 0, reason: 'no_linked_tasks' };
  }

  const isRoomoteEvent = parsedInput.event.roomoteAuthored === true;
  const isRoomoteSummary =
    isRoomoteEvent && parsedInput.event.kind === 'review_summary';
  let event = parsedInput.event;
  let previousCycleRaw: string | null = null;
  let completedCycleKey: string | null = null;
  let completedCycleValue: string | null = null;

  if (isRoomoteEvent && event.reviewHeadSha) {
    try {
      const cycle = await readPrReviewCycleState({
        repository: parsedInput.repository,
        prNumber: parsedInput.prNumber,
        reviewHeadSha: event.reviewHeadSha,
      });

      if (!isRoomoteSummary && cycle.state?.phase === 'completed') {
        if (
          event.observedAt === undefined ||
          event.observedAt <= cycle.state.observedAt
        ) {
          return {
            notifiedTaskCount: 0,
            reason: 'review_cycle_completed',
          };
        }
      }

      if (
        isRoomoteSummary &&
        cycle.state &&
        event.observedAt !== undefined &&
        cycle.state.observedAt > event.observedAt
      ) {
        return {
          notifiedTaskCount: 0,
          reason: 'stale_review_cycle',
        };
      }

      const cycleId =
        cycle.state?.phase === 'completed'
          ? (event.batchId ?? `head:${event.reviewHeadSha}`)
          : (cycle.state?.cycleId ??
            event.batchId ??
            `head:${event.reviewHeadSha}`);
      event = { ...event, batchId: cycleId };

      if (isRoomoteSummary) {
        const completedState = JSON.stringify({
          cycleId,
          phase: 'completed',
          observedAt: event.observedAt ?? Date.now(),
        } satisfies PrReviewCycleState);
        completedCycleKey = getPrReviewCompletedCycleKey({
          repository: parsedInput.repository,
          prNumber: parsedInput.prNumber,
          cycleId,
        });
        completedCycleValue = completedState;
        previousCycleRaw = cycle.raw;

        const completed = await getRedis().eval(
          COMPLETE_REVIEW_CYCLE_SCRIPT,
          2,
          cycle.key,
          completedCycleKey,
          cycleId,
          event.observedAt ?? Date.now(),
          completedState,
          REVIEW_CYCLE_TTL_SECONDS,
        );

        if (completed !== 1) {
          return {
            notifiedTaskCount: 0,
            reason: 'stale_review_cycle',
          };
        }
      }
    } catch (error) {
      // Completion lookups are an optimization. Fail open so transient Redis
      // reads never discard review feedback.
      if (isRoomoteSummary) {
        throw error;
      }
    }
  }

  let notifiedTaskCount = 0;
  const notificationDelayMs = isRoomoteSummary
    ? 0
    : isRoomoteEvent
      ? PR_REVIEW_NOTIFICATION_ROOMOTE_FALLBACK_MS
      : PR_REVIEW_NOTIFICATION_DEBOUNCE_MS;

  try {
    for (const taskId of taskIds) {
      const immediate = isRoomoteSummary;
      const target = {
        taskId,
        repository: parsedInput.repository,
        prNumber: parsedInput.prNumber,
        immediate,
        batchKind: isRoomoteEvent ? ('roomote' as const) : ('human' as const),
        ...(event.batchId ? { batchId: event.batchId } : {}),
      };

      const claimed = await appendPendingEventAndClaimSchedule({
        target,
        event,
        delayMs: notificationDelayMs,
      });

      if (claimed) {
        try {
          await getPrReviewNotificationQueue().add(
            'notify-pr-review-activity',
            {
              ...target,
              prUrl: parsedInput.prUrl,
              deferrals: 0,
              immediate,
              sourceControlProvider: parsedInput.sourceControlProvider,
            },
            { delay: notificationDelayMs },
          );
        } catch (error) {
          await getRedis()
            .del(buildScheduledMarkerKey(target))
            .catch(() => undefined);
          throw error;
        }
      }

      notifiedTaskCount += 1;
    }
  } catch (error) {
    if (completedCycleKey && completedCycleValue && event.reviewHeadSha) {
      const cycleStateKey = getPrReviewCycleStateKey({
        repository: parsedInput.repository,
        prNumber: parsedInput.prNumber,
        reviewHeadSha: event.reviewHeadSha,
      });
      await getRedis()
        .del(completedCycleKey)
        .catch(() => undefined);
      await getRedis()
        .eval(
          RESTORE_REVIEW_CYCLE_IF_VALUE_MATCHES_SCRIPT,
          1,
          cycleStateKey,
          completedCycleValue,
          previousCycleRaw ?? '',
          REVIEW_CYCLE_TTL_SECONDS,
        )
        .catch(() => undefined);
    }

    throw error;
  }

  return { notifiedTaskCount };
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

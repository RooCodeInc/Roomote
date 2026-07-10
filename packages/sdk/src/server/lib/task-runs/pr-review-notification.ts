import { Queue } from 'bullmq';
import { z } from 'zod';

import type { TaskRun } from '@roomote/db/server';
import {
  and,
  db,
  eq,
  inArray,
  taskPullRequests,
  taskRuns,
  tasks,
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
 * Debounce window between the first observed review event and the chat
 * notification so a review submission with several inline comments collapses
 * into a single message.
 */
export const PR_REVIEW_NOTIFICATION_DEBOUNCE_MS = 1 * 60 * 1000;

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

export const prReviewActivityEventSchema = z.object({
  kind: z.enum(['review', 'review_comment', 'review_summary']),
  authorLogin: z.string(),
  /** GitHub review state for `review` events, e.g. `approved`. */
  reviewState: z.string().optional(),
  /** Short human-readable summary text for `review_summary` events. */
  summary: z.string().optional(),
  /** HTML URL of the review or comment the event describes, when known. */
  url: z.string().optional(),
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
  sourceControlProvider: sourceControlProviderSchema.optional(),
});

export type PrReviewNotificationRequest = z.infer<
  typeof prReviewNotificationRequestSchema
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
  | { provider: 'telegram'; channelId: string; threadId: string | null };

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
}: {
  taskId: string;
  repository: string;
  prNumber: number;
}): string {
  return `${encodeURIComponent(taskId)}:${encodeURIComponent(repository)}#${prNumber}`;
}

function buildPendingEventsKey(target: {
  taskId: string;
  repository: string;
  prNumber: number;
}): string {
  return `pr-review-notification:pending:${buildTargetKeySuffix(target)}`;
}

function buildScheduledMarkerKey(target: {
  taskId: string;
  repository: string;
  prNumber: number;
}): string {
  return `pr-review-notification:scheduled:${buildTargetKeySuffix(target)}`;
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
}: {
  target: { taskId: string; repository: string; prNumber: number };
  event: PrReviewActivityEvent;
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
    Math.ceil(PR_REVIEW_NOTIFICATION_DEBOUNCE_MS / 1000) +
    SCHEDULED_MARKER_TTL_BUFFER_SECONDS;

  const claim = await redis.set(markerKey, '1', 'EX', markerTtlSeconds, 'NX');

  return claim === 'OK';
}

/**
 * Atomically drains the pending review-activity events for the task and
 * clears the scheduled marker so later events schedule a fresh notification.
 */
export async function consumePendingPrReviewActivity(target: {
  taskId: string;
  repository: string;
  prNumber: number;
}): Promise<PrReviewActivityEvent[]> {
  const redis = getRedis();
  const pendingKey = buildPendingEventsKey(target);
  const markerKey = buildScheduledMarkerKey(target);

  await redis.del(markerKey).catch(() => undefined);

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

  return events;
}

/**
 * Requeues events that could not be delivered so a retried notification job
 * can pick them up again.
 */
export async function requeuePendingPrReviewActivity({
  target,
  events,
}: {
  target: { taskId: string; repository: string; prNumber: number };
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
 * conversation-backed tasks that own the pull request, and schedules a
 * debounced notification job per task. The notification is informational
 * only: it tells the user about the review feedback once the task is idle.
 * No agent turn is started.
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

  const linkedRuns = await db
    .select({
      taskId: taskRuns.taskId,
      payload: taskRuns.payload,
      slackThreadTs: tasks.slackThreadTs,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(inArray(taskRuns.taskId, taskIds));

  const conversationTaskIds = Array.from(
    new Set(
      linkedRuns
        .filter((job) => hasPrReviewNotificationThreadContext(job))
        .map((job) => job.taskId),
    ),
  );

  if (conversationTaskIds.length === 0) {
    return { notifiedTaskCount: 0, reason: 'no_thread_context' };
  }

  let notifiedTaskCount = 0;

  for (const taskId of conversationTaskIds) {
    const target = {
      taskId,
      repository: parsedInput.repository,
      prNumber: parsedInput.prNumber,
    };

    const claimed = await appendPendingEventAndClaimSchedule({
      target,
      event: parsedInput.event,
    });

    if (claimed) {
      try {
        await getPrReviewNotificationQueue().add(
          'notify-pr-review-activity',
          {
            ...target,
            prUrl: parsedInput.prUrl,
            deferrals: 0,
            sourceControlProvider: parsedInput.sourceControlProvider,
          },
          { delay: PR_REVIEW_NOTIFICATION_DEBOUNCE_MS },
        );
      } catch (error) {
        const redis = getRedis();
        await redis.del(buildScheduledMarkerKey(target)).catch(() => undefined);
        throw error;
      }
    }

    notifiedTaskCount += 1;
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

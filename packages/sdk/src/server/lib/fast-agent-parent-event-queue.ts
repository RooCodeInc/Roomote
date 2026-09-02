import { createHash } from 'node:crypto';

import { Queue } from 'bullmq';

import {
  acquireFastAgentTurnLock,
  findFastAgentDurableRetryScheduledError,
} from '@roomote/cloud-agents/server';
import {
  and,
  asc,
  db,
  eq,
  fastAgentParentEvents,
  gt,
  isNull,
  lt,
  lte,
  or,
  sql,
  taskRuns,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  RunStatus,
  exitedRunStatuses,
  type FastAgentParent,
} from '@roomote/types';

import {
  buildEventClientMessageSeed,
  deliverFastAgentParentEventWithLock,
  FastAgentParentEventDeliveryError,
  type FastAgentParentEvent,
} from './fast-agent-parent-event';
import { retryFastAgentStartup } from './task-runs/fast-agent-startup-retry';

export const FAST_AGENT_PARENT_EVENT_QUEUE_NAME = 'fast-agent-parent-events';

export type FastAgentParentEventQueueRequest = {
  conversationId: string;
  eventKey: string;
};
type FastAgentPullRequestOpenedEvent = Extract<
  FastAgentParentEvent,
  { type: 'pull_request_opened' }
>;

export class FastAgentParentBusyError extends Error {
  constructor() {
    super('Fast parent conversation is busy; retry the durable queue later.');
    this.name = 'FastAgentParentBusyError';
  }
}

let fastAgentParentEventQueue: Queue<FastAgentParentEventQueueRequest> | null =
  null;
const EXITED_RUN_STATUSES = new Set<RunStatus>(exitedRunStatuses);

function getFastAgentParentEventQueue() {
  fastAgentParentEventQueue ??= new Queue<FastAgentParentEventQueueRequest>(
    FAST_AGENT_PARENT_EVENT_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        // PostgreSQL remains the source of truth. A scheduled recovery sweep
        // recreates jobs for rows that exhaust a transient BullMQ attempt.
        removeOnFail: true,
      },
    },
  );
  return fastAgentParentEventQueue;
}

export function buildFastAgentParentEventKey(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
}): string {
  return createHash('sha256')
    .update(params.parent.sessionId)
    .update('\0')
    .update(buildEventClientMessageSeed(params.event))
    .digest('hex');
}

async function addWakeupJob(request: FastAgentParentEventQueueRequest) {
  await getFastAgentParentEventQueue().add('deliver', request, {
    jobId: request.eventKey,
  });
}

/**
 * Wake the queue for a persisted row right away, for an interrupted inline
 * owner handing its turn back. Failure is not fatal: the recovery sweep
 * recreates the wakeup within its interval.
 */
export async function wakeFastAgentParentEventNow(
  request: FastAgentParentEventQueueRequest,
): Promise<void> {
  await addWakeupJob(request);
}

/**
 * Wake the queue for a durably scheduled retry once its time arrives. The
 * job id carries the scheduled time so a repeated schedule (the owner's own
 * hint plus every recovery sweep before the time) collapses into one wakeup
 * while a later reschedule of the same row still gets its own. Failure is
 * not fatal: the recovery sweep re-adds the delayed wakeup.
 */
export async function wakeFastAgentParentEventAt(
  request: FastAgentParentEventQueueRequest,
  retryAt: Date,
): Promise<void> {
  await getFastAgentParentEventQueue().add('deliver', request, {
    jobId: `${request.eventKey}-retry-${retryAt.getTime()}`,
    delay: Math.max(0, retryAt.getTime() - Date.now()),
  });
}

function wakeFastAgentParentEvent(request: FastAgentParentEventQueueRequest) {
  void addWakeupJob(request).catch((error) => {
    // Admission is already durable. BullMQ startup and its periodic recovery
    // sweep recreate the wakeup without making the child task wait or retry.
    console.error(
      `[FastAgentParentEventQueue] Persisted ${request.eventKey}, but its immediate wakeup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/** Persist before acknowledging so child work never waits on the parent. */
export async function enqueueFastAgentParentEvent(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  retryTaskStartRunId?: number;
}): Promise<{ eventKey: string; queued: true }> {
  const eventKey = buildFastAgentParentEventKey(params);
  await db
    .insert(fastAgentParentEvents)
    .values({
      conversationId: params.parent.sessionId,
      eventKey,
      parent: params.parent,
      event: params.event,
      retryTaskStartRunId: params.retryTaskStartRunId,
    })
    .onConflictDoNothing({ target: fastAgentParentEvents.eventKey });

  wakeFastAgentParentEvent({
    conversationId: params.parent.sessionId,
    eventKey,
  });

  return { eventKey, queued: true };
}

/** Serialize PR-open admission with terminal run updates on the same row. */
export async function enqueueFastAgentParentEventForRun(params: {
  parent: FastAgentParent;
  event: FastAgentPullRequestOpenedEvent;
  runId: number;
}): Promise<{ eventKey: string; queued: boolean }> {
  const eventKey = buildFastAgentParentEventKey(params);
  const queued = await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: taskRuns.status })
      .from(taskRuns)
      .where(eq(taskRuns.id, params.runId))
      .limit(1)
      .for('update');
    if (!run || EXITED_RUN_STATUSES.has(run.status)) {
      return false;
    }

    await tx
      .insert(fastAgentParentEvents)
      .values({
        conversationId: params.parent.sessionId,
        eventKey,
        parent: params.parent,
        event: params.event,
      })
      .onConflictDoNothing({ target: fastAgentParentEvents.eventKey });
    return true;
  });

  if (queued) {
    wakeFastAgentParentEvent({
      conversationId: params.parent.sessionId,
      eventKey,
    });
  }
  return { eventKey, queued };
}

function pendingPredicate(conversationId?: string) {
  return and(
    ...(conversationId
      ? [eq(fastAgentParentEvents.conversationId, conversationId)]
      : []),
    isNull(fastAgentParentEvents.deliveredAt),
    isNull(fastAgentParentEvents.discardedAt),
    // An inline-admitted turn stays with its live owner while the owner's
    // claim is current; the queue takes over once the claim is released or
    // expires.
    or(
      isNull(fastAgentParentEvents.claimedUntil),
      lt(fastAgentParentEvents.claimedUntil, new Date()),
    ),
    // A durably scheduled inference retry is not due before its time.
    or(
      isNull(fastAgentParentEvents.retryAt),
      lte(fastAgentParentEvents.retryAt, new Date()),
    ),
  );
}

/** Pending rows parked for a durable inference retry that is not due yet. */
function scheduledRetryPredicate() {
  return and(
    isNull(fastAgentParentEvents.deliveredAt),
    isNull(fastAgentParentEvents.discardedAt),
    gt(fastAgentParentEvents.retryAt, new Date()),
  );
}

async function getNextPendingEvent(conversationId: string) {
  return db.query.fastAgentParentEvents.findFirst({
    where: pendingPredicate(conversationId),
    orderBy: [
      asc(fastAgentParentEvents.createdAt),
      asc(fastAgentParentEvents.id),
    ],
  });
}

function isFastAgentParentEvent(value: unknown): value is FastAgentParentEvent {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    typeof value.type === 'string',
  );
}

async function buildRetryTaskStart(
  runId: number | null,
  parent: FastAgentParent,
) {
  if (runId === null) return undefined;
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });
  return run ? () => retryFastAgentStartup(run, parent) : undefined;
}

async function isStillPending(id: string): Promise<boolean> {
  const row = await db.query.fastAgentParentEvents.findFirst({
    where: eq(fastAgentParentEvents.id, id),
    columns: { deliveredAt: true, discardedAt: true },
  });
  return Boolean(row) && !row!.deliveredAt && !row!.discardedAt;
}

async function markDelivered(id: string) {
  await db
    .update(fastAgentParentEvents)
    .set({ deliveredAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(fastAgentParentEvents.id, id));
}

async function markDiscarded(id: string, error: unknown) {
  await db
    .update(fastAgentParentEvents)
    .set({
      discardedAt: new Date(),
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    })
    .where(eq(fastAgentParentEvents.id, id));
}

/** Drain one parent's durable inbox in creation order under one turn lock. */
export async function drainFastAgentParentEvents(
  request: FastAgentParentEventQueueRequest,
): Promise<void> {
  const first = await getNextPendingEvent(request.conversationId);
  if (!first) return;

  const parent = first.parent;
  if (parent.sessionId !== request.conversationId) {
    await markDiscarded(first.id, 'Queued parent identity did not match.');
    return drainFastAgentParentEvents(request);
  }

  // Admission is already durable, so a busy parent should not occupy a worker
  // slot. BullMQ moves this wakeup to delayed and retries without consuming an
  // attempt. Once acquired, event execution itself has no wall-clock cutoff.
  const turnLock = await acquireFastAgentTurnLock({
    conversation: parent.conversation,
    maxWaitMs: 0,
  });
  if (!turnLock) {
    throw new FastAgentParentBusyError();
  }

  try {
    for (;;) {
      const row = await getNextPendingEvent(request.conversationId);
      if (!row) return;
      if (
        row.parent.sessionId !== request.conversationId ||
        !isFastAgentParentEvent(row.event)
      ) {
        await markDiscarded(row.id, 'Queued Fast parent event was invalid.');
        continue;
      }

      await db
        .update(fastAgentParentEvents)
        .set({
          attempts: sql`${fastAgentParentEvents.attempts} + 1`,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(fastAgentParentEvents.id, row.id));

      try {
        const retryTaskStart = await buildRetryTaskStart(
          row.retryTaskStartRunId,
          row.parent,
        );
        const wakeRequest = {
          conversationId: request.conversationId,
          eventKey: row.eventKey,
        };
        await deliverFastAgentParentEventWithLock(
          {
            parent: row.parent,
            event: row.event,
            ...(retryTaskStart ? { retryTaskStart } : {}),
            // An inline-admitted row only reaches the queue after its owner
            // was interrupted or parked it for a scheduled retry, so this
            // delivery is a resumption of the same turn.
            ...(row.admission === 'inline'
              ? {
                  ...(row.retryAt
                    ? { resumedAfterInferenceRetry: true }
                    : { resumedAfterInterruption: true }),
                  // The resumed run owns the same row: it revokes replay
                  // before any non-replayable action, so a worker death
                  // after such an action cannot drain the row again. The
                  // consumed retry count keeps the per-turn cap honest.
                  durableAdmission: {
                    eventId: row.id,
                    inferenceRetries: row.inferenceRetries,
                  },
                  // A resumed run that is interrupted again, or parks itself
                  // for another retry, hands the row back through these.
                  requestDurableResume: () =>
                    wakeFastAgentParentEventNow(wakeRequest),
                  requestDurableRetry: (retryAt: Date) =>
                    wakeFastAgentParentEventAt(wakeRequest, retryAt),
                }
              : {}),
          },
          turnLock,
        );
        if (row.admission === 'inline') {
          // The resumed run settles its own row (delivered, or withdrawn
          // from replay before a terminal action), so nothing is written
          // here. If it is still pending, the run handed it back without
          // settling: its terminal revocation did not land and it released
          // the claim for the next recovery sweep. Do not re-run it in a
          // tight loop.
          if (await isStillPending(row.id)) {
            console.warn(
              `[FastAgentParentEventQueue] Resumed Fast turn ${row.id} handed itself back to the queue; leaving it pending.`,
            );
            return;
          }
          continue;
        }
        await markDelivered(row.id);
      } catch (error) {
        if (findFastAgentDurableRetryScheduledError(error)) {
          // The resumed run parked itself for a scheduled retry: the row
          // already carries its retry time and its delayed wakeup is queued,
          // so this drain is simply done with it.
          console.info(
            `[FastAgentParentEventQueue] Resumed Fast turn ${row.id} parked itself for a scheduled retry.`,
          );
          return;
        }
        const deliveryError =
          error instanceof FastAgentParentEventDeliveryError ? error : null;
        if (deliveryError?.replyPosted) {
          await markDelivered(row.id);
          continue;
        }
        if (deliveryError?.permanent) {
          await markDiscarded(row.id, deliveryError);
          continue;
        }

        await db
          .update(fastAgentParentEvents)
          .set({
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(fastAgentParentEvents.id, row.id));
        throw error;
      }
    }
  } finally {
    await turnLock().catch(() => {});
  }
}

/** Recreate BullMQ wakeups for durable rows after restarts or Redis outages. */
export async function recoverPendingFastAgentParentEvents(): Promise<number> {
  const rows = await db
    .select({
      conversationId: fastAgentParentEvents.conversationId,
      eventKey: fastAgentParentEvents.eventKey,
    })
    .from(fastAgentParentEvents)
    .where(pendingPredicate())
    .orderBy(
      asc(fastAgentParentEvents.createdAt),
      asc(fastAgentParentEvents.id),
    );

  for (const row of rows) {
    await addWakeupJob(row);
  }

  // Rows parked for a scheduled retry get their delayed wakeup re-added, so
  // a Redis outage or a restart between the schedule and its time does not
  // leave the retry waiting for a sweep that happens to land after it.
  const scheduled = await db
    .select({
      conversationId: fastAgentParentEvents.conversationId,
      eventKey: fastAgentParentEvents.eventKey,
      retryAt: fastAgentParentEvents.retryAt,
    })
    .from(fastAgentParentEvents)
    .where(scheduledRetryPredicate());
  for (const row of scheduled) {
    await wakeFastAgentParentEventAt(
      { conversationId: row.conversationId, eventKey: row.eventKey },
      row.retryAt!,
    );
  }
  return rows.length;
}

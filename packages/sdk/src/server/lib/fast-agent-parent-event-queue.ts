import { createHash } from 'node:crypto';

import { Queue } from 'bullmq';

import { acquireFastAgentTurnLock } from '@roomote/cloud-agents/server';
import {
  and,
  asc,
  db,
  eq,
  fastAgentParentEvents,
  isNull,
  lt,
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
        await deliverFastAgentParentEventWithLock(
          {
            parent: row.parent,
            event: row.event,
            ...(retryTaskStart ? { retryTaskStart } : {}),
            // An inline-admitted row only reaches the queue after its owner
            // was interrupted, so this delivery is a resumption.
            ...(row.admission === 'inline'
              ? {
                  resumedAfterInterruption: true,
                  // The resumed run owns the same row: it revokes replay
                  // before any non-replayable action, so a worker death
                  // after such an action cannot drain the row again.
                  durableAdmission: { eventId: row.id },
                }
              : {}),
          },
          turnLock,
        );
        if (row.admission === 'inline' && (await isStillPending(row.id))) {
          // The resumed run settles its own row. If it is still pending, the
          // run deferred itself (its terminal revocation did not land) and
          // released the claim; leave it for the next recovery sweep rather
          // than settling it here or re-running it in a tight loop.
          console.warn(
            `[FastAgentParentEventQueue] Resumed Fast turn ${row.id} deferred itself; leaving it for the next recovery sweep.`,
          );
          return;
        }
        await markDelivered(row.id);
      } catch (error) {
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
  return rows.length;
}

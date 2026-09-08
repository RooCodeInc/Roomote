import { createHash } from 'node:crypto';

import { Queue } from 'bullmq';

import {
  acquireFastAgentTurnLock,
  findFastAgentDurableRetryScheduledError,
} from '@roomote/cloud-agents/server';
import {
  and,
  automationWebhookDeliveries,
  asc,
  db,
  eq,
  fastAgentParentEvents,
  gt,
  isNull,
  lt,
  lte,
  or,
  recordCustomAutomationRunOutcome,
  recordSessionWakeupOutcome,
  settleRunningAutomationWebhookDeliveryForSession,
  markAutomationWebhookDeliveryRunning,
  sql,
  taskRuns,
  type DatabaseOrTransaction,
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
const MAX_DELIVERY_ATTEMPTS = 3;

function getFastAgentParentEventQueue() {
  fastAgentParentEventQueue ??= new Queue<FastAgentParentEventQueueRequest>(
    FAST_AGENT_PARENT_EVENT_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: MAX_DELIVERY_ATTEMPTS,
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
  const hash = createHash('sha256')
    .update(params.parent.sessionId)
    .update('\0')
    .update(buildEventClientMessageSeed(params.event));
  if (
    params.event.type === 'automation_triggered' &&
    params.event.launchClaimedAt
  ) {
    hash.update('\0').update(params.event.launchClaimedAt);
  }
  return hash.digest('hex');
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
  webhookLease?: { deliveryId: string; leaseToken: string };
}): Promise<{ eventKey: string; queued: true }> {
  const eventKey = buildFastAgentParentEventKey(params);
  const persist = async (client: DatabaseOrTransaction) =>
    client
      .insert(fastAgentParentEvents)
      .values({
        conversationId: params.parent.sessionId,
        eventKey,
        parent: params.parent,
        event: params.event,
        retryTaskStartRunId: params.retryTaskStartRunId,
      })
      .onConflictDoNothing({ target: fastAgentParentEvents.eventKey });

  if (params.webhookLease) {
    await db.transaction(async (tx) => {
      if (
        !(await markAutomationWebhookDeliveryRunning(
          params.webhookLease!.deliveryId,
          params.webhookLease!.leaseToken,
          params.parent.sessionId,
          tx,
        ))
      )
        throw new Error('Webhook dispatch lease is no longer current.');
      await persist(tx);
    });
  } else {
    await persist(db);
  }

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

async function markDelivered(
  id: string,
  client: Pick<typeof db, 'update'> = db,
) {
  await client
    .update(fastAgentParentEvents)
    .set({ deliveredAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(fastAgentParentEvents.id, id));
}

async function markDiscarded(
  id: string,
  error: unknown,
  client: Pick<typeof db, 'update'> = db,
) {
  await client
    .update(fastAgentParentEvents)
    .set({
      discardedAt: new Date(),
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    })
    .where(eq(fastAgentParentEvents.id, id));
}

function getAutomationLaunchClaim(event: FastAgentParentEvent) {
  if (event.type !== 'automation_triggered') return null;

  const prefix = `${event.automationId}:`;
  if (!event.eventId.startsWith(prefix)) return null;

  const launchClaimedAt = new Date(
    event.launchClaimedAt ?? event.eventId.slice(prefix.length),
  );
  if (Number.isNaN(launchClaimedAt.getTime())) return null;

  return { id: event.automationId, launchClaimedAt };
}

async function finalizeAutomationLaunch(
  sessionId: string,
  event: FastAgentParentEvent,
  status: 'succeeded' | 'failed',
  error?: unknown,
  inboxId?: string,
) {
  if (
    await settleRunningAutomationWebhookDeliveryForSession(
      sessionId,
      inboxId
        ? {
            id: inboxId,
            status: status === 'succeeded' ? 'delivered' : 'discarded',
            ...(status === 'failed'
              ? {
                  error: error instanceof Error ? error.message : String(error),
                }
              : {}),
          }
        : undefined,
    )
  )
    return true;
  const claim = getAutomationLaunchClaim(event);
  if (!claim) {
    if (event.type === 'automation_triggered' && event.webhookDeliveryId) {
      throw new Error('Webhook automation launch claim is missing or invalid.');
    }
    return false;
  }

  if (event.type === 'automation_triggered' && event.webhookDeliveryId) {
    throw new Error(
      'Webhook delivery settlement did not match a running delivery.',
    );
  }

  await recordCustomAutomationRunOutcome(db, {
    ...claim,
    status,
    ...(status === 'failed'
      ? { error: error instanceof Error ? error.message : String(error) }
      : {}),
  });
  return false;
}

async function finalizeScheduledWakeup(
  event: FastAgentParentEvent,
  status: 'succeeded' | 'failed',
  error?: unknown,
) {
  if (event.type !== 'scheduled_wakeup') return;

  await recordSessionWakeupOutcome({
    id: event.wakeupId,
    status,
    ...(status === 'failed'
      ? { error: error instanceof Error ? error.message : String(error) }
      : {}),
  });
}

/** Drain one parent's durable inbox in creation order under one turn lock. */
export async function drainFastAgentParentEvents(
  request: FastAgentParentEventQueueRequest,
): Promise<void> {
  const first = await getNextPendingEvent(request.conversationId);
  if (!first) return;

  const parent = first.parent;
  if (parent.sessionId !== request.conversationId) {
    if (
      !(await settleRunningAutomationWebhookDeliveryForSession(
        request.conversationId,
        {
          id: first.id,
          status: 'discarded',
          error: 'Queued parent identity did not match.',
        },
      ))
    )
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
    // Followups carry no webhook id. The persisted Session association also
    // covers child events and rows admitted before durable execution shipped.
    const webhook = await db.query.automationWebhookDeliveries.findFirst({
      where: eq(automationWebhookDeliveries.sessionId, request.conversationId),
      columns: { id: true },
    });
    for (;;) {
      const row = await getNextPendingEvent(request.conversationId);
      if (!row) return;
      if (
        row.parent.sessionId !== request.conversationId ||
        !isFastAgentParentEvent(row.event)
      ) {
        if (
          !(await settleRunningAutomationWebhookDeliveryForSession(
            request.conversationId,
            {
              id: row.id,
              status: 'discarded',
              error: 'Queued Fast parent event was invalid.',
            },
          ))
        )
          await markDiscarded(row.id, 'Queued Fast parent event was invalid.');
        continue;
      }

      const webhookTurn =
        Boolean(webhook) ||
        (row.event.type === 'automation_triggered' &&
          Boolean(row.event.webhookDeliveryId));
      const durableTurn = row.admission === 'inline' || webhookTurn;
      const resumedTurn = row.admission === 'inline' || (row.attempts ?? 0) > 0;
      await db
        .update(fastAgentParentEvents)
        .set({
          attempts: sql`${fastAgentParentEvents.attempts} + 1`,
          ...(webhookTurn ? { admission: 'inline' as const } : {}),
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
        if (durableTurn) {
          // Bind the row to the lock the way the inline surfaces do, so a
          // process shutdown that aborts this turn before it reaches its own
          // abort handling (still in setup, no inference yet) can release
          // the claim and wake the queue instead of leaving the row held
          // until its lease expires.
          turnLock.durableRowId = row.id;
          turnLock.durableResume = () =>
            wakeFastAgentParentEventNow(wakeRequest);
        }
        const result = await deliverFastAgentParentEventWithLock(
          {
            parent: row.parent,
            event: row.event,
            ...(retryTaskStart ? { retryTaskStart } : {}),
            // Newly promoted webhook rows start fresh; existing inline rows
            // resume the same recorded turn after interruption or backoff.
            ...(durableTurn
              ? {
                  ...(row.retryAt
                    ? { resumedAfterInferenceRetry: true }
                    : resumedTurn
                      ? { resumedAfterInterruption: true }
                      : {}),
                  // The resumed run owns the same row and is told what the
                  // earlier attempt already did, so it continues rather than
                  // repeating actions. The consumed retry count keeps the
                  // per-turn cap honest.
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
        if (durableTurn && result !== 'skipped') {
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
          await settleRunningAutomationWebhookDeliveryForSession(
            request.conversationId,
          );
          continue;
        }
        const settled = await finalizeAutomationLaunch(
          request.conversationId,
          row.event,
          'succeeded',
          undefined,
          row.id,
        );
        await finalizeScheduledWakeup(row.event, 'succeeded');
        if (!settled) await markDelivered(row.id);
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
        // A shutdown after a progress reply is not a completed turn. Its
        // durable row and tool journal must remain available to the successor.
        if (durableTurn && turnLock.signal.aborted) throw error;
        if (deliveryError?.replyPosted && !webhookTurn) {
          const settled = await finalizeAutomationLaunch(
            request.conversationId,
            row.event,
            'succeeded',
            undefined,
            row.id,
          );
          await finalizeScheduledWakeup(row.event, 'succeeded');
          if (!settled) await markDelivered(row.id);
          continue;
        }
        // Inference parks have their own persisted runtime budget. Do not
        // count those handoffs as queue failures; ordinary setup/reply errors
        // must still terminate even when the recovery sweep recreates jobs.
        if (
          deliveryError?.permanent ||
          (webhookTurn &&
            (row.attempts ?? 0) + 1 - (row.inferenceRetries ?? 0) >=
              MAX_DELIVERY_ATTEMPTS)
        ) {
          const settled = await finalizeAutomationLaunch(
            request.conversationId,
            row.event,
            'failed',
            error,
            row.id,
          );
          await finalizeScheduledWakeup(row.event, 'failed', error);
          if (!settled) await markDiscarded(row.id, error);
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
      } finally {
        // The same lock carries every row this drain delivers; a settled or
        // handed-back row must not stay bound to it.
        delete turnLock.durableRowId;
        delete turnLock.durableResume;
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

import { createHash } from 'node:crypto';

import { Queue } from 'bullmq';

import {
  acquireFastAgentTurnLock,
  buildFastAgentUserContentBlocks,
  findFastAgentDurableRetryScheduledError,
} from '@roomote/cloud-agents/server';
import {
  allocateFastAgentConversationSequence,
  and,
  asc,
  db,
  type DatabaseOrTransaction,
  eq,
  fastAgentParentEvents,
  fastAgentMessages,
  gt,
  isNull,
  lt,
  lte,
  or,
  recordCustomAutomationRunOutcome,
  recordSessionWakeupOutcome,
  sql,
  taskRuns,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY,
  FAST_AGENT_EVENT_SEMANTICS_VERSION,
  RunStatus,
  buildFastAgentInputSemantics,
  exitedRunStatuses,
  type FastAgentParent,
  type FastAgentHumanFollowUpEvent,
  type FastAgentEventSemantics,
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

function buildSetupDiscoveryCompletedEvent(
  event: FastAgentHumanFollowUpEvent,
): FastAgentHumanFollowUpEvent | null {
  if (!event.setupContext) return null;
  const snapshot = JSON.parse(event.setupContext.setupSnapshot) as Record<
    string,
    unknown
  >;
  const discovery =
    snapshot.integrationDiscovery &&
    typeof snapshot.integrationDiscovery === 'object' &&
    !Array.isArray(snapshot.integrationDiscovery)
      ? (snapshot.integrationDiscovery as Record<string, unknown>)
      : {};
  const nextSnapshot = {
    ...snapshot,
    integrationDiscovery: { ...discovery, completed: true },
  };
  const eventId = `${event.eventId}:integration-discovery-completed`;
  return {
    type: 'human_follow_up',
    eventId,
    currentMessageId: eventId,
    userId: event.userId,
    question: `<platform_event>${JSON.stringify({
      type: 'setup_state_changed',
      snapshot: nextSnapshot,
      changes: [{ type: 'integration_discovery_completed' }],
    })}</platform_event>`,
    turnSource: 'platform_event',
    platformEventKind: 'setup',
    platformEventVisibility: 'required',
    setupSession: true,
    setupContext: {
      ...event.setupContext,
      setupSnapshot: JSON.stringify(nextSnapshot),
    },
  };
}
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

function parseEventDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function buildCanonicalEventSemantics(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  observedAt: Date;
}): FastAgentEventSemantics {
  const { event, parent, observedAt } = params;
  const base = {
    schemaVersion: FAST_AGENT_EVENT_SEMANTICS_VERSION,
    observedAt: observedAt.toISOString(),
    sourceEventId: buildEventClientMessageSeed(event),
  } as const;
  switch (event.type) {
    case 'human_follow_up': {
      // One rule decides what a Session input claims, shared with the turn
      // that persists its own input, so admission and execution cannot
      // disagree about the same row.
      return buildFastAgentInputSemantics({
        sessionId: parent.sessionId,
        observedAt,
        sourceEventId: base.sourceEventId,
        platformEvent: event.turnSource === 'platform_event',
        ...(event.turnSource === 'platform_event' &&
        event.platformEventKind === 'setup'
          ? {
              setupSnapshot:
                event.setupContext?.setupSnapshot ?? event.question,
            }
          : {}),
      });
    }
    case 'scheduled_wakeup':
      return {
        ...base,
        kind: 'historical_observation',
        authority: 'roomote_runtime',
        occurredAt: event.firedAt,
        subject: { type: 'session_wakeup', id: event.wakeupId },
        version: { scheme: 'monotonic_number', value: event.runNumber },
      };
    case 'automation_triggered':
      return {
        ...base,
        kind: 'historical_observation',
        authority: 'automation',
        ...(event.launchClaimedAt ? { occurredAt: event.launchClaimedAt } : {}),
        subject: { type: 'automation', id: event.automationId },
      };
    case 'child_message':
      return {
        ...base,
        kind: 'historical_observation',
        authority: 'delegated_task',
        subject: { type: 'task_run', id: String(event.runId) },
      };
    case 'artifact_published':
      return {
        ...base,
        kind: 'state_change',
        authority: 'roomote_runtime',
        subject: { type: 'artifact', id: event.artifact.id },
        version: { scheme: 'monotonic_number', value: event.artifact.version },
        state: `published:${event.artifact.version}`,
      };
    case 'task_settled':
      return {
        ...base,
        kind: 'current_state_assertion',
        authority: 'roomote_runtime',
        subject: { type: 'task_run', id: String(event.runId) },
        state: event.status,
      };
    case 'pull_request_opened':
      return {
        ...base,
        // This records that a task opened or updated the pull request; it is
        // not a claim about the PR's current status. That distinction is what
        // keeps a merged or closed assertion authoritative even when a later
        // task re-emits this event for the same PR, so no invented lifecycle
        // version is needed here.
        kind: 'state_change',
        authority: 'source_control',
        subject: { type: 'pull_request', id: event.pullRequest.url },
        state: event.pullRequest.status ?? 'open',
      };
    case 'pull_request_feedback':
      return {
        ...base,
        kind: 'historical_observation',
        authority: 'source_control',
        subject: { type: 'pull_request', id: event.pullRequest.url },
        ...(event.reviewResult?.headSha
          ? { version: { scheme: 'opaque', value: event.reviewResult.headSha } }
          : {}),
      };
    case 'pull_request_status_changed':
      return {
        ...base,
        kind: 'current_state_assertion',
        authority: 'source_control',
        subject: { type: 'pull_request', id: event.pullRequest.url },
        state: event.status,
      };
    case 'pull_request_conflict_detected':
      return {
        ...base,
        kind: 'current_state_assertion',
        authority: 'source_control',
        occurredAt: event.conflictDetectedAt,
        observedAt: parseEventDate(
          event.conflictDetectedAt,
          observedAt,
        ).toISOString(),
        subject: { type: 'pull_request_conflict', id: event.pullRequest.url },
        state: 'conflicting',
      };
  }
}

async function persistQueuedEventCanonicalInput(
  tx: DatabaseOrTransaction,
  params: { parent: FastAgentParent; event: FastAgentParentEvent },
  admittedAt: Date,
): Promise<void> {
  const eventSeed = buildEventClientMessageSeed(params.event);
  const turnId =
    params.event.type === 'human_follow_up'
      ? params.event.currentMessageId
      : eventSeed;
  const eventId = `${turnId}:user`;
  const existing = await tx.query.fastAgentMessages.findFirst({
    where: and(
      eq(fastAgentMessages.conversationId, params.parent.sessionId),
      eq(fastAgentMessages.eventId, eventId),
    ),
    columns: { id: true },
  });
  if (existing) return;
  const observedAt =
    params.event.type === 'scheduled_wakeup'
      ? parseEventDate(params.event.firedAt, admittedAt)
      : params.event.type === 'pull_request_conflict_detected'
        ? parseEventDate(params.event.conflictDetectedAt, admittedAt)
        : params.event.type === 'automation_triggered'
          ? parseEventDate(params.event.launchClaimedAt, admittedAt)
          : admittedAt;
  const question =
    params.event.type === 'human_follow_up'
      ? params.event.question
      : `<platform_event>${JSON.stringify(params.event)}</platform_event>`;
  const semantics = buildCanonicalEventSemantics({
    ...params,
    observedAt,
  });
  await tx.insert(fastAgentMessages).values({
    conversationId: params.parent.sessionId,
    conversationSeq: await allocateFastAgentConversationSequence(
      tx,
      params.parent.sessionId,
    ),
    eventId,
    turnId,
    turnSeq: 0,
    ts: observedAt.getTime(),
    observedAt,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    role: 'user',
    contentBlocks: buildFastAgentUserContentBlocks(
      question,
      params.event.type === 'human_follow_up'
        ? (params.event.images ?? [])
        : [],
    ),
    metadata: {
      visibleInTranscript:
        params.event.type === 'human_follow_up' && !params.event.turnSource,
      turnSource:
        params.event.type === 'human_follow_up'
          ? (params.event.turnSource ?? 'human')
          : 'platform_event',
      ...(params.event.type === 'human_follow_up' &&
      params.event.platformEventKind
        ? { platformEventKind: params.event.platformEventKind }
        : params.event.type !== 'human_follow_up'
          ? { platformEventKind: 'delegated_task' }
          : {}),
      [FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY]: semantics,
    },
    payload: {},
    source: params.parent.conversation.surface,
  });
}

/** Persist before acknowledging so child work never waits on the parent. */
export async function enqueueFastAgentParentEvent(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  retryTaskStartRunId?: number;
}): Promise<{ eventKey: string; queued: true }> {
  const eventKey = buildFastAgentParentEventKey(params);
  await db.transaction(async (tx) => {
    const admittedAt = new Date();
    await tx
      .insert(fastAgentParentEvents)
      .values({
        conversationId: params.parent.sessionId,
        eventKey,
        parent: params.parent,
        event: params.event,
        retryTaskStartRunId: params.retryTaskStartRunId,
        createdAt: admittedAt,
        updatedAt: admittedAt,
      })
      .onConflictDoNothing({ target: fastAgentParentEvents.eventKey });
    await persistQueuedEventCanonicalInput(tx, params, admittedAt);
  });

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
    await persistQueuedEventCanonicalInput(tx, params, new Date());
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
  event: FastAgentParentEvent,
  status: 'succeeded' | 'failed',
  error?: unknown,
) {
  const claim = getAutomationLaunchClaim(event);
  if (!claim) return;

  await recordCustomAutomationRunOutcome(db, {
    ...claim,
    status,
    ...(status === 'failed'
      ? { error: error instanceof Error ? error.message : String(error) }
      : {}),
  });
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
        const durableSetupEvent =
          row.event.type === 'human_follow_up' && row.event.setupContext
            ? row.event
            : null;
        if (row.admission === 'inline') {
          // Bind the row to the lock the way the inline surfaces do, so a
          // process shutdown that aborts this turn before it reaches its own
          // abort handling (still in setup, no inference yet) can release
          // the claim and wake the queue instead of leaving the row held
          // until its lease expires.
          turnLock.durableRowId = row.id;
          turnLock.durableResume = () =>
            wakeFastAgentParentEventNow(wakeRequest);
        }
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
            ...(durableSetupEvent
              ? {
                  onSetupIntegrationDiscoveryCompleted: async () => {
                    const continuation =
                      buildSetupDiscoveryCompletedEvent(durableSetupEvent);
                    if (!continuation) return;
                    await enqueueFastAgentParentEvent({
                      parent: row.parent,
                      event: continuation,
                    });
                  },
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
        await finalizeAutomationLaunch(row.event, 'succeeded');
        await finalizeScheduledWakeup(row.event, 'succeeded');
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
          await finalizeAutomationLaunch(row.event, 'succeeded');
          await finalizeScheduledWakeup(row.event, 'succeeded');
          await markDelivered(row.id);
          continue;
        }
        if (deliveryError?.permanent) {
          await finalizeAutomationLaunch(row.event, 'failed', deliveryError);
          await finalizeScheduledWakeup(row.event, 'failed', deliveryError);
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

import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { db, type DatabaseOrTransaction } from '../db';
import {
  automationWebhookDeliveries as deliveries,
  automationWebhookTriggers as triggers,
  customAutomations,
  fastAgentParentEvents,
  sessionTasks,
  tasks,
  taskRuns,
  automationWebhookDailyBudgets as budgets,
} from '../schema';
import { recordCustomAutomationRunOutcome } from './custom-automations';

export type AutomationWebhookDelivery = typeof deliveries.$inferSelect;
export type AcceptAutomationWebhookDeliveryInput = Pick<
  AutomationWebhookDelivery,
  'triggerId' | 'eventId' | 'eventType' | 'noteId' | 'occurredAt'
>;
export const AUTOMATION_WEBHOOK_PENDING_CAP = 100;
export const AUTOMATION_WEBHOOK_MAX_ATTEMPTS = 5;
export const AUTOMATION_WEBHOOK_LEASE_MS = 5 * 60 * 1000;
export const AUTOMATION_WEBHOOK_GLOBAL_ACTIVE_CAP = 5;
export const AUTOMATION_WEBHOOK_GLOBAL_DAILY_CAP = 200;
export const AUTOMATION_WEBHOOK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTOMATION_WEBHOOK_STALLED_MS = 60 * 60 * 1000;

function dayStart(now: Date) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Deduplicate first; ignore terminal filters but retry management/backlog gates. */
export async function acceptAutomationWebhookDelivery(
  input: AcceptAutomationWebhookDeliveryInput,
): Promise<'accepted' | 'duplicate' | 'ignored' | 'capacity'> {
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select({ automationId: triggers.automationId })
      .from(triggers)
      .where(eq(triggers.id, input.triggerId));
    if (!identity) return 'ignored';
    const [automation] = await tx
      .select({ enabled: customAutomations.enabled })
      .from(customAutomations)
      .where(eq(customAutomations.id, identity.automationId))
      .for('update');
    const [trigger] = await tx
      .select()
      .from(triggers)
      .where(eq(triggers.id, input.triggerId))
      .for('update');
    if (!trigger) return 'ignored';
    const [existing] = await tx
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.triggerId, input.triggerId),
          eq(deliveries.eventId, input.eventId),
        ),
      );
    if (existing) return 'duplicate';
    // Management may still be replacing enabled/events. Do not acknowledge a
    // new event against those intermediate values and lose the provider retry.
    if (trigger.status !== 'active') return 'capacity';
    if (
      !automation?.enabled ||
      !trigger.enabled ||
      !trigger.events.includes(input.eventType)
    )
      return 'ignored';
    // Once dedup metadata expires, ancient provider events must not launch again.
    const now = Date.now();
    const occurredAt = input.occurredAt.getTime();
    if (
      !Number.isFinite(occurredAt) ||
      occurredAt < now - AUTOMATION_WEBHOOK_RETENTION_MS ||
      occurredAt > now + 5 * 60 * 1000
    )
      return 'ignored';
    const [backlog] = await tx
      .select({ total: count() })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.triggerId, input.triggerId),
          inArray(deliveries.status, ['pending', 'dispatching', 'running']),
        ),
      );
    if ((backlog?.total ?? 0) >= AUTOMATION_WEBHOOK_PENDING_CAP)
      return 'capacity';
    await tx.insert(deliveries).values(input);
    return 'accepted';
  });
}

/** Trigger locks serialize dispatch across workers; running deliveries never expire. */
export async function claimAutomationWebhookDelivery(): Promise<
  | (AutomationWebhookDelivery & { automationId: string; leaseToken: string })
  | null
> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const candidates = await tx
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.enabled, true),
          eq(triggers.status, 'active'),
          sql`exists (select 1 from ${deliveries} d where d.trigger_id = ${triggers.id} and d.status in ('pending', 'dispatching') and d.next_attempt_at <= ${now.toISOString()}::timestamp)`,
        ),
      )
      .orderBy(asc(triggers.id))
      .for('update', { skipLocked: true });
    for (const trigger of candidates) {
      const [active] = await tx
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.triggerId, trigger.id),
            inArray(deliveries.status, ['dispatching', 'running']),
          ),
        )
        .orderBy(asc(deliveries.createdAt))
        .limit(1);
      if (
        active &&
        (active.status === 'running' ||
          !active.leaseUntil ||
          active.leaseUntil > now ||
          active.attempts >= AUTOMATION_WEBHOOK_MAX_ATTEMPTS)
      )
        continue;
      // A reserved retry owns the automation until terminal settlement, ahead of new events.
      const [pending] = active
        ? [active]
        : await tx
            .select()
            .from(deliveries)
            .where(
              and(
                eq(deliveries.triggerId, trigger.id),
                eq(deliveries.status, 'pending'),
              ),
            )
            .orderBy(
              sql`${deliveries.launchClaimedAt} nulls last`,
              asc(deliveries.createdAt),
            )
            .limit(1);
      if (
        !pending ||
        pending.nextAttemptAt > now ||
        pending.attempts >= AUTOMATION_WEBHOOK_MAX_ATTEMPTS
      )
        continue;
      if (!pending.firstDispatchedAt) {
        const [daily] = await tx
          .select({ total: count() })
          .from(deliveries)
          .where(
            and(
              eq(deliveries.triggerId, trigger.id),
              gte(deliveries.firstDispatchedAt, dayStart(now)),
            ),
          );
        if ((daily?.total ?? 0) >= trigger.maxRunsPerDay) continue;
      }
      const leaseToken = randomUUID();
      const [claimed] = await tx
        .update(deliveries)
        .set({
          status: 'dispatching',
          attempts: pending.attempts + 1,
          leaseToken,
          leaseUntil: new Date(now.getTime() + AUTOMATION_WEBHOOK_LEASE_MS),
          updatedAt: now,
        })
        .where(
          and(
            eq(deliveries.id, pending.id),
            inArray(deliveries.status, ['pending', 'dispatching']),
          ),
        )
        .returning();
      if (claimed)
        return { ...claimed, automationId: trigger.automationId, leaseToken };
    }
    return null;
  });
}

/** Persist occurrence identity together with the automation fence before any external launch. */
export async function reserveWebhookAutomationLaunch(
  deliveryId: string,
  leaseToken: string,
): Promise<Date | null> {
  return db.transaction(async (tx) => {
    // Global budget lock always precedes automation -> trigger -> delivery locks.
    await tx.execute(sql`select pg_advisory_xact_lock(734821905)`);
    const [identity] = await tx
      .select({ automationId: triggers.automationId, triggerId: triggers.id })
      .from(deliveries)
      .innerJoin(triggers, eq(triggers.id, deliveries.triggerId))
      .where(eq(deliveries.id, deliveryId));
    if (!identity) return null;
    // All paths needing both locks take automation, then trigger, then delivery.
    const [automation] = await tx
      .select()
      .from(customAutomations)
      .where(eq(customAutomations.id, identity.automationId))
      .for('update');
    const [trigger] = await tx
      .select()
      .from(triggers)
      .where(eq(triggers.id, identity.triggerId))
      .for('update');
    const [delivery] = await tx
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.id, deliveryId),
          eq(deliveries.leaseToken, leaseToken),
          eq(deliveries.status, 'dispatching'),
          gte(deliveries.leaseUntil, new Date()),
        ),
      )
      .for('update');
    if (
      !automation?.enabled ||
      !trigger?.enabled ||
      trigger.status !== 'active' ||
      !delivery
    )
      return null;
    if (delivery.launchClaimedAt) {
      if (
        automation.launchClaimedAt &&
        automation.launchClaimedAt.getTime() !==
          delivery.launchClaimedAt.getTime()
      )
        return null;
      await tx
        .update(customAutomations)
        .set({
          launchClaimedAt: delivery.launchClaimedAt,
          updatedAt: new Date(),
        })
        .where(eq(customAutomations.id, automation.id));
      return delivery.launchClaimedAt;
    }
    // Do not steal even stale scheduled claims: the scheduler owns their recovery.
    if (automation.launchClaimedAt) return null;
    const now = new Date();
    const [daily] = await tx
      .select({ total: count() })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.triggerId, trigger.id),
          gte(deliveries.firstDispatchedAt, dayStart(now)),
        ),
      );
    if ((daily?.total ?? 0) >= trigger.maxRunsPerDay) return null;
    const [active] = await tx
      .select({ total: count() })
      .from(deliveries)
      .where(
        and(
          sql`${deliveries.launchClaimedAt} is not null`,
          inArray(deliveries.status, ['pending', 'dispatching', 'running']),
        ),
      );
    if ((active?.total ?? 0) >= AUTOMATION_WEBHOOK_GLOBAL_ACTIVE_CAP)
      return null;
    const day = now.toISOString().slice(0, 10);
    // Seed from existing deliveries when upgrading an already-used inbox.
    await tx
      .insert(budgets)
      .values({
        day,
        reservations: sql`(select count(*)::integer from ${deliveries} where ${deliveries.firstDispatchedAt} >= ${dayStart(now).toISOString()}::timestamp)`,
      })
      .onConflictDoNothing();
    const [budget] = await tx
      .update(budgets)
      .set({ reservations: sql`${budgets.reservations} + 1` })
      .where(
        and(
          eq(budgets.day, day),
          lt(budgets.reservations, AUTOMATION_WEBHOOK_GLOBAL_DAILY_CAP),
        ),
      )
      .returning({ day: budgets.day });
    if (!budget) return null;
    await tx
      .update(customAutomations)
      .set({ launchClaimedAt: now, updatedAt: now })
      .where(eq(customAutomations.id, automation.id));
    await tx
      .update(deliveries)
      .set({ launchClaimedAt: now, firstDispatchedAt: now, updatedAt: now })
      .where(eq(deliveries.id, delivery.id));
    return now;
  });
}

/** Delete one bounded batch, measured from terminal settlement, never live work. */
export async function cleanupAutomationWebhookDeliveries(): Promise<number> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          inArray(deliveries.status, ['succeeded', 'failed']),
          lt(
            deliveries.updatedAt,
            new Date(Date.now() - AUTOMATION_WEBHOOK_RETENTION_MS),
          ),
        ),
      )
      .orderBy(asc(deliveries.updatedAt))
      .limit(1000)
      .for('update', { skipLocked: true });
    if (!expired.length) return 0;
    const removed = await tx
      .delete(deliveries)
      .where(
        inArray(
          deliveries.id,
          expired.map((row) => row.id),
        ),
      )
      .returning({ id: deliveries.id });
    return removed.length;
  });
}

/** Visibility only: an unknown running outcome must never be automatically replayed. */
export async function flagStalledAutomationWebhookDeliveries(): Promise<number> {
  const error =
    'Webhook execution outcome unknown after one hour. Manually inspect the session before taking action; automatic replay is disabled.';
  const flagged = await db
    .update(deliveries)
    .set({ lastError: error })
    .where(
      and(
        eq(deliveries.status, 'running'),
        lt(
          deliveries.updatedAt,
          new Date(Date.now() - AUTOMATION_WEBHOOK_STALLED_MS),
        ),
        sql`${deliveries.lastError} is null`,
      ),
    )
    .returning({ id: deliveries.id });
  return flagged.length;
}

export async function markAutomationWebhookDeliveryRunning(
  id: string,
  leaseToken: string,
  sessionId: string,
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const rows = await client
    .update(deliveries)
    .set({
      status: 'running',
      sessionId,
      leaseUntil: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveries.id, id),
        eq(deliveries.leaseToken, leaseToken),
        eq(deliveries.status, 'dispatching'),
        gte(deliveries.leaseUntil, new Date()),
      ),
    )
    .returning({ id: deliveries.id });
  return rows.length > 0;
}

type WebhookInboxOutcome = {
  id: string;
  status: 'delivered' | 'discarded';
  error?: string;
};

/**
 * Caller must hold this session's Fast turn lock throughout the call.
 * Returns whether a running webhook handled this inbox, not whether execution is terminal.
 */
export async function settleRunningAutomationWebhookDeliveryForSession(
  sessionId: string,
  inbox?: WebhookInboxOutcome,
): Promise<boolean> {
  return (await reconcileRunningWebhookSession(sessionId, inbox)).handled;
}

async function reconcileRunningWebhookSession(
  sessionId: string,
  inbox?: WebhookInboxOutcome,
): Promise<{ handled: boolean; settled: number }> {
  return db.transaction(async (tx) => {
    const identities = await tx
      .select({ id: deliveries.id, automationId: triggers.automationId })
      .from(deliveries)
      .innerJoin(triggers, eq(triggers.id, deliveries.triggerId))
      .where(
        and(
          eq(deliveries.sessionId, sessionId),
          eq(deliveries.status, 'running'),
        ),
      )
      .orderBy(asc(triggers.automationId), asc(deliveries.id));
    let handled = false;
    let settled = 0;
    for (const identity of identities) {
      // Dispatch and settlement both acquire automation -> delivery -> inbox.
      await tx
        .select({ id: customAutomations.id })
        .from(customAutomations)
        .where(eq(customAutomations.id, identity.automationId))
        .for('update');
      const [delivery] = await tx
        .select()
        .from(deliveries)
        .where(
          and(eq(deliveries.id, identity.id), eq(deliveries.status, 'running')),
        )
        .for('update');
      if (!delivery) continue;
      const children = await tx
        .selectDistinctOn([tasks.id], {
          id: tasks.id,
          state: tasks.state,
          runId: taskRuns.id,
          runCreatedAt: taskRuns.createdAt,
        })
        .from(sessionTasks)
        .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
        .leftJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
        .where(eq(sessionTasks.sessionId, sessionId))
        .orderBy(asc(tasks.id), desc(taskRuns.id));
      const rows = await tx
        .select()
        .from(fastAgentParentEvents)
        .where(eq(fastAgentParentEvents.conversationId, sessionId))
        .orderBy(asc(fastAgentParentEvents.id))
        .for('update');
      if (inbox) {
        const current = rows.find((row) => row.id === inbox.id);
        if (!current)
          throw new Error('Webhook completion inbox row is missing.');
        if (!current.deliveredAt && !current.discardedAt) {
          const now = new Date();
          const outcome =
            inbox.status === 'delivered'
              ? { deliveredAt: now, lastError: null }
              : {
                  discardedAt: now,
                  lastError: inbox.error ?? 'Fast parent event was discarded.',
                };
          await tx
            .update(fastAgentParentEvents)
            .set({ ...outcome, updatedAt: now })
            .where(eq(fastAgentParentEvents.id, current.id));
          Object.assign(current, outcome);
        }
      }
      handled = true;
      const discarded = rows.find((row) => row.discardedAt);
      const failedChild = children.find(
        (child) => child.state === 'failed' || child.state === 'canceled',
      );
      const error = discarded
        ? discarded.lastError || 'Fast parent event was discarded.'
        : failedChild
          ? `Child task ${failedChild.id} ${failedChild.state}.`
          : null;
      const origin = rows.find(
        (row) =>
          row.event.type === 'automation_triggered' &&
          row.event.webhookDeliveryId === delivery.id,
      );
      // Task state commits before notification admission. A terminal child alone
      // is not evidence that its parent's final followup has been processed.
      const missingChildNotification = children.some(
        (child) =>
          !child.runId ||
          !child.runCreatedAt ||
          !rows.some(
            (row) =>
              (row.deliveredAt || row.discardedAt) &&
              row.event.taskId === child.id &&
              ((row.event.type === 'task_settled' &&
                row.event.runId === child.runId) ||
                (row.event.type === 'pull_request_feedback' &&
                  row.createdAt >= child.runCreatedAt! &&
                  (row.event.runId === undefined ||
                    row.event.runId === child.runId))),
          ),
      );
      if (
        !origin ||
        (!origin.deliveredAt && !origin.discardedAt) ||
        children.some((child) => child.state === 'active') ||
        missingChildNotification ||
        rows.some((row) => !row.deliveredAt && !row.discardedAt)
      ) {
        if (error)
          await tx
            .update(deliveries)
            .set({ lastError: error })
            .where(eq(deliveries.id, delivery.id));
        continue;
      }
      const status = error ? 'failed' : 'succeeded';
      if (delivery.launchClaimedAt)
        await recordCustomAutomationRunOutcome(tx, {
          id: identity.automationId,
          launchClaimedAt: delivery.launchClaimedAt,
          status,
          ...(error ? { error } : {}),
        });
      await settleAutomationWebhookDelivery(delivery.id, status, error, tx);
      settled++;
    }
    return { handled, settled };
  });
}

/**
 * Repair completion from durable state only. Never enqueue or replay execution.
 * Caller must hold the Fast turn locks for every session examined by this sweep.
 * Production schedulers should instead lock one session and call
 * settleRunningAutomationWebhookDeliveryForSession under that lock.
 */
export async function reconcileRunningAutomationWebhookDeliveries(): Promise<number> {
  let cursor: string | undefined;
  let settled = 0;
  for (;;) {
    const batch = await db
      .select({ id: deliveries.id, sessionId: deliveries.sessionId })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.status, 'running'),
          cursor ? gt(deliveries.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(deliveries.id))
      .limit(100);
    for (const delivery of batch) {
      if (delivery.sessionId)
        settled += (await reconcileRunningWebhookSession(delivery.sessionId))
          .settled;
    }
    if (batch.length < 100) return settled;
    cursor = batch[batch.length - 1]!.id;
  }
}

export async function retryAutomationWebhookDelivery(
  id: string,
  leaseToken: string,
  error: string,
  busy = false,
): Promise<boolean> {
  return retryWebhookDelivery(id, leaseToken, error, busy, false);
}

async function retryWebhookDelivery(
  id: string,
  leaseToken: string,
  error: string,
  busy: boolean,
  expiredOnly: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select({ automationId: triggers.automationId, triggerId: triggers.id })
      .from(deliveries)
      .innerJoin(triggers, eq(triggers.id, deliveries.triggerId))
      .where(eq(deliveries.id, id));
    if (!identity) return false;
    await tx
      .select({ id: customAutomations.id })
      .from(customAutomations)
      .where(eq(customAutomations.id, identity.automationId))
      .for('update');
    await tx
      .select({ id: triggers.id })
      .from(triggers)
      .where(eq(triggers.id, identity.triggerId))
      .for('update');
    const [delivery] = await tx
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.id, id),
          eq(deliveries.leaseToken, leaseToken),
          eq(deliveries.status, 'dispatching'),
          expiredOnly
            ? and(
                lte(deliveries.leaseUntil, new Date()),
                gte(deliveries.attempts, AUTOMATION_WEBHOOK_MAX_ATTEMPTS),
              )
            : gte(deliveries.leaseUntil, new Date()),
        ),
      )
      .for('update');
    if (!delivery) return false;
    const exhausted =
      !busy && delivery.attempts >= AUTOMATION_WEBHOOK_MAX_ATTEMPTS;
    // Fast inbox insertion and the fenced running transition commit together.
    // A still-dispatching delivery therefore has no committed execution to lose.
    const status = exhausted ? 'failed' : 'pending';
    if (exhausted && delivery.launchClaimedAt) {
      await recordCustomAutomationRunOutcome(tx, {
        id: identity.automationId,
        status: 'failed',
        error,
        launchClaimedAt: delivery.launchClaimedAt,
      });
    }
    await tx
      .update(deliveries)
      .set({
        status,
        attempts: busy ? Math.max(0, delivery.attempts - 1) : delivery.attempts,
        nextAttemptAt: new Date(
          Date.now() +
            (busy ? 30_000 : Math.min(300_000, 1000 * 2 ** delivery.attempts)),
        ),
        leaseUntil: null,
        leaseToken: null,
        lastError: error,
        updatedAt: new Date(),
      })
      .where(eq(deliveries.id, id));
    return true;
  });
}

/** Reap last-attempt crashes without taking automation locks under claim's trigger lock. */
export async function reconcileExhaustedAutomationWebhookDeliveries(): Promise<number> {
  const exhausted = await db
    .select({ id: deliveries.id, leaseToken: deliveries.leaseToken })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.status, 'dispatching'),
        gte(deliveries.attempts, AUTOMATION_WEBHOOK_MAX_ATTEMPTS),
        lte(deliveries.leaseUntil, new Date()),
      ),
    )
    .orderBy(asc(deliveries.leaseUntil))
    .limit(100);
  let reconciled = 0;
  for (const delivery of exhausted) {
    if (
      delivery.leaseToken &&
      (await retryWebhookDelivery(
        delivery.id,
        delivery.leaseToken,
        'Webhook dispatch attempts exhausted.',
        false,
        true,
      ))
    )
      reconciled++;
  }
  return reconciled;
}

/** Trusted execution settlement may arrive before the dispatcher records the session. */
export async function settleAutomationWebhookDelivery(
  id: string,
  status: 'succeeded' | 'failed',
  error?: string | null,
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const rows = await client
    .update(deliveries)
    .set({
      status,
      lastError: error ?? null,
      leaseUntil: null,
      leaseToken: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveries.id, id),
        or(
          inArray(deliveries.status, ['running', 'dispatching']),
          and(
            eq(deliveries.status, 'pending'),
            sql`${deliveries.launchClaimedAt} is not null`,
          ),
        ),
      ),
    )
    .returning({ id: deliveries.id });
  if (rows.length > 0) return true;
  const [existing] = await client
    .select({ status: deliveries.status })
    .from(deliveries)
    .where(eq(deliveries.id, id));
  return existing?.status === status;
}

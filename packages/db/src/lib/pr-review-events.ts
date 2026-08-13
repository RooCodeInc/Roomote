import { createHash, randomUUID } from 'node:crypto';

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import type { SourceControlProvider } from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import {
  prReviewCycles,
  prReviewEventDeliveries,
  prReviewEvents,
  taskPullRequests,
} from '../schema';

const CLAIM_LIMIT = 100;
const DELIVERY_LEASE_MS = 10 * 60 * 1000;
const EVENT_ASSOCIATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DurablePrReviewEvent = {
  eventKey: string;
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  prUrl: string;
  event: Record<string, unknown>;
  batchKind: 'human' | 'roomote';
  batchId: string | null;
  automatedAuthorId?: string;
  dueAt: Date;
  observedAt: Date;
  reviewHeadSha?: string | null;
  roomoteAuthored?: boolean;
  isSummary?: boolean;
};

export type ClaimedPrReviewDelivery = {
  deliveryIds: string[];
  leaseToken: string;
  taskId: string;
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  prUrl: string;
  batchKind: 'human' | 'roomote';
  batchId: string | null;
  deferrals: number;
  events: Record<string, unknown>[];
};

/**
 * The external post and the database completion cannot be one transaction.
 * Delivery is consequently at-least-once; Postgres is still the sole owner of
 * pending work and an expired processing lease is the only recovery path.
 */

function advisoryLockKey(
  provider: SourceControlProvider,
  repository: string,
  prNumber: number,
): string {
  return `${provider}:${repository.toLowerCase()}#${prNumber}`;
}

export async function lockPrReviewReference(
  executor: DatabaseOrTransaction,
  provider: SourceControlProvider,
  repository: string,
  prNumber: number,
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${advisoryLockKey(provider, repository, prNumber)}, 0))`,
  );
}

function eventIdentity(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  eventKey: string;
}) {
  return and(
    eq(prReviewEvents.sourceControlProvider, input.sourceControlProvider),
    eq(prReviewEvents.repository, input.repository),
    eq(prReviewEvents.prNumber, input.prNumber),
    eq(prReviewEvents.eventKey, input.eventKey),
  );
}

function reviewReference(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
}) {
  return and(
    eq(prReviewEvents.sourceControlProvider, input.sourceControlProvider),
    eq(prReviewEvents.repository, input.repository),
    eq(prReviewEvents.prNumber, input.prNumber),
  );
}

function cycleHeadReference(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
}) {
  return and(
    eq(prReviewCycles.sourceControlProvider, input.sourceControlProvider),
    eq(prReviewCycles.repository, input.repository),
    eq(prReviewCycles.prNumber, input.prNumber),
    eq(prReviewCycles.reviewHeadSha, input.reviewHeadSha),
  );
}

function cycleIdentity(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
  cycleId: string;
}) {
  return and(
    cycleHeadReference(input),
    eq(prReviewCycles.cycleId, input.cycleId),
  );
}

async function projectEventToTasks(
  executor: DatabaseOrTransaction,
  eventId: string,
  dueAt: Date,
  taskIds: string[],
): Promise<number> {
  if (taskIds.length === 0) return 0;

  const inserted = await executor
    .insert(prReviewEventDeliveries)
    .values(taskIds.map((taskId) => ({ eventId, taskId, dueAt })))
    .onConflictDoNothing()
    .returning({ id: prReviewEventDeliveries.id });
  return inserted.length;
}

async function suppressRoomoteActivity(
  executor: DatabaseOrTransaction,
  input: {
    sourceControlProvider: SourceControlProvider;
    repository: string;
    prNumber: number;
    reviewHeadSha: string;
    cycleId: string;
    startedAt: Date;
    observedAt: Date;
  },
): Promise<void> {
  const nextCycle = await executor.query.prReviewCycles.findFirst({
    where: and(
      cycleHeadReference(input),
      gt(prReviewCycles.startedAt, input.startedAt),
    ),
    orderBy: [asc(prReviewCycles.startedAt)],
    columns: { startedAt: true },
  });
  const cycleWindow = nextCycle
    ? and(
        gte(prReviewEvents.observedAt, input.startedAt),
        lt(prReviewEvents.observedAt, nextCycle.startedAt),
      )
    : and(
        gte(prReviewEvents.observedAt, input.startedAt),
        lte(prReviewEvents.observedAt, input.observedAt),
      );
  const events = await executor
    .update(prReviewEvents)
    .set({ superseded: true })
    .where(
      and(
        reviewReference(input),
        eq(prReviewEvents.batchKind, 'roomote'),
        eq(prReviewEvents.reviewHeadSha, input.reviewHeadSha),
        eq(prReviewEvents.superseded, false),
        or(eq(prReviewEvents.batchId, input.cycleId), cycleWindow),
        sql`${prReviewEvents.event}->>'kind' <> 'review_summary'`,
      ),
    )
    .returning({ id: prReviewEvents.id });

  if (events.length === 0) return;

  await executor
    .update(prReviewEventDeliveries)
    .set({ status: 'suppressed', leaseToken: null, leaseExpiresAt: null })
    .where(
      and(
        inArray(
          prReviewEventDeliveries.eventId,
          events.map(({ id }) => id),
        ),
        inArray(prReviewEventDeliveries.status, ['pending', 'processing']),
      ),
    );
}

/**
 * Resolves the open quiet-period generation for one automated reviewer.
 * Claiming and persistence take the same advisory lock: once any delivery in
 * a generation leaves pending state, that generation is sealed and later
 * activity starts a distinct batch instead of revoking an in-flight claim.
 */
async function resolveAutomatedBatchId(
  executor: DatabaseOrTransaction,
  input: DurablePrReviewEvent & { automatedAuthorId: string; batchId: string },
): Promise<string> {
  await executor.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        jsonb_build_array(
          'pr-review-automated-batch',
          ${input.sourceControlProvider}::text,
          ${input.repository}::text,
          ${String(input.prNumber)}::text,
          ${input.automatedAuthorId}::text
        )::text,
        0
      )
    )
  `);

  const [openGeneration] = await executor.execute<{
    batch_id: string;
  }>(sql`
    select e.batch_id
    from ${prReviewEvents} e
    where e.source_control_provider = ${input.sourceControlProvider}
      and e.repository = ${input.repository}
      and e.pr_number = ${input.prNumber}
      and e.batch_kind = 'human'
      and e.superseded = false
      and e.sealed_at is null
      and e.event->>'automatedAuthorId' = ${input.automatedAuthorId}
      and e.batch_id is not null
    group by e.batch_id
    order by max(e.created_at) desc,
             e.batch_id desc
    limit 1
  `);

  if (openGeneration) return openGeneration.batch_id;

  const [existing] = await executor.execute<{ exists: boolean }>(sql`
    select exists (
      select 1
      from ${prReviewEvents} e
      where e.source_control_provider = ${input.sourceControlProvider}
        and e.repository = ${input.repository}
        and e.pr_number = ${input.prNumber}
        and e.batch_kind = 'human'
        and e.event->>'automatedAuthorId' = ${input.automatedAuthorId}
    ) as exists
  `);

  if (!existing?.exists) return input.batchId;

  const generation = createHash('sha256')
    .update(input.eventKey)
    .digest('hex')
    .slice(0, 16);
  return `${input.batchId}:generation:${generation}`;
}

/** Extends the trailing quiet period for one still-open generation. */
async function coalesceAutomatedActivity(
  executor: DatabaseOrTransaction,
  input: Pick<
    DurablePrReviewEvent,
    'sourceControlProvider' | 'repository' | 'prNumber' | 'batchId' | 'dueAt'
  >,
): Promise<void> {
  if (!input.batchId) return;
  const dueAtIso = input.dueAt.toISOString();

  const events = await executor
    .update(prReviewEvents)
    .set({
      availableAt: sql`greatest(${prReviewEvents.availableAt}, ${dueAtIso}::timestamp)`,
    })
    .where(
      and(
        reviewReference(input),
        eq(prReviewEvents.batchKind, 'human'),
        eq(prReviewEvents.batchId, input.batchId),
        eq(prReviewEvents.superseded, false),
      ),
    )
    .returning({ id: prReviewEvents.id });

  if (events.length === 0) return;

  await executor
    .update(prReviewEventDeliveries)
    .set({
      status: 'pending',
      dueAt: sql`greatest(${prReviewEventDeliveries.dueAt}, ${dueAtIso}::timestamp)`,
    })
    .where(
      and(
        inArray(
          prReviewEventDeliveries.eventId,
          events.map(({ id }) => id),
        ),
        eq(prReviewEventDeliveries.status, 'pending'),
      ),
    );
}

export async function persistPrReviewEventInTransaction(
  executor: DatabaseOrTransaction,
  input: DurablePrReviewEvent,
): Promise<{
  projectedTaskCount: number;
  event: Record<string, unknown>;
  reason?: 'review_cycle_completed' | 'stale_review_cycle';
}> {
  await lockPrReviewReference(
    executor,
    input.sourceControlProvider,
    input.repository,
    input.prNumber,
  );

  let cycle = null;
  if (input.roomoteAuthored && input.reviewHeadSha) {
    if (input.isSummary && input.batchId) {
      cycle = await executor.query.prReviewCycles.findFirst({
        where: cycleIdentity({
          ...input,
          reviewHeadSha: input.reviewHeadSha,
          cycleId: input.batchId,
        }),
      });
    }
    if (!(input.isSummary && input.batchId)) {
      cycle ??= await executor.query.prReviewCycles.findFirst({
        where: and(
          cycleHeadReference({ ...input, reviewHeadSha: input.reviewHeadSha }),
          lte(prReviewCycles.startedAt, input.observedAt),
        ),
        orderBy: [desc(prReviewCycles.startedAt)],
      });
    }
  }
  const superseded = Boolean(
    input.roomoteAuthored &&
    !input.isSummary &&
    cycle?.completedAt &&
    input.observedAt <= cycle.completedAt,
  );
  const staleSummary = Boolean(
    input.isSummary &&
    cycle?.completedAt &&
    cycle.completedAt > input.observedAt,
  );
  const automatedBatchId =
    input.automatedAuthorId && input.batchId
      ? await resolveAutomatedBatchId(executor, {
          ...input,
          automatedAuthorId: input.automatedAuthorId,
          batchId: input.batchId,
        })
      : null;
  const batchId = cycle?.cycleId ?? automatedBatchId ?? input.batchId;
  const eventPayload = batchId ? { ...input.event, batchId } : input.event;

  const [inserted] = await executor
    .insert(prReviewEvents)
    .values({
      eventKey: input.eventKey,
      sourceControlProvider: input.sourceControlProvider,
      repository: input.repository,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      event: eventPayload,
      batchKind: input.batchKind,
      batchId,
      reviewHeadSha: input.reviewHeadSha,
      superseded: superseded || staleSummary,
      availableAt: input.dueAt,
      observedAt: input.observedAt,
    })
    .onConflictDoNothing()
    .returning({
      id: prReviewEvents.id,
      superseded: prReviewEvents.superseded,
    });
  const stored =
    inserted ??
    (await executor.query.prReviewEvents.findFirst({
      where: eventIdentity(input),
      columns: { id: true, superseded: true },
    }));

  if (!stored) throw new Error('Failed to persist PR review event');

  if (inserted && input.isSummary && !staleSummary && input.reviewHeadSha) {
    const cycleId = batchId ?? `head:${input.reviewHeadSha}`;
    await executor
      .insert(prReviewCycles)
      .values({
        sourceControlProvider: input.sourceControlProvider,
        repository: input.repository,
        prNumber: input.prNumber,
        reviewHeadSha: input.reviewHeadSha,
        cycleId,
        startedAt: cycle?.startedAt ?? new Date(0),
        completedAt: input.observedAt,
      })
      .onConflictDoUpdate({
        target: [
          prReviewCycles.sourceControlProvider,
          prReviewCycles.repository,
          prReviewCycles.prNumber,
          prReviewCycles.reviewHeadSha,
          prReviewCycles.cycleId,
        ],
        set: { completedAt: input.observedAt },
      });
    await suppressRoomoteActivity(executor, {
      ...input,
      reviewHeadSha: input.reviewHeadSha,
      cycleId,
      startedAt: cycle?.startedAt ?? new Date(0),
    });
  }

  if (inserted && input.automatedAuthorId) {
    await coalesceAutomatedActivity(executor, { ...input, batchId });
  }

  if (!inserted || stored.superseded) {
    return {
      projectedTaskCount: 0,
      event: eventPayload,
      ...(superseded ? { reason: 'review_cycle_completed' as const } : {}),
      ...(staleSummary ? { reason: 'stale_review_cycle' as const } : {}),
    };
  }

  const links = await executor.query.taskPullRequests.findMany({
    where: and(
      eq(taskPullRequests.sourceControlProvider, input.sourceControlProvider),
      eq(taskPullRequests.repository, input.repository),
      eq(taskPullRequests.prNumber, input.prNumber),
    ),
    columns: { taskId: true },
  });
  const taskIds = [...new Set(links.map(({ taskId }) => taskId))];
  const projectedTaskCount = await projectEventToTasks(
    executor,
    stored.id,
    input.dueAt,
    taskIds,
  );
  return { projectedTaskCount, event: eventPayload };
}

export async function persistPrReviewEvent(input: DurablePrReviewEvent) {
  return db.transaction((tx) => persistPrReviewEventInTransaction(tx, input));
}

export async function recordPrReviewCycleState(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
  cycleId: string;
  phase: 'open' | 'completed';
  observedAt: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPrReviewReference(
      tx,
      input.sourceControlProvider,
      input.repository,
      input.prNumber,
    );
    const existing = await tx.query.prReviewCycles.findFirst({
      where: cycleIdentity(input),
    });
    if (input.phase === 'open') {
      if (existing) return;
      await tx.insert(prReviewCycles).values({
        sourceControlProvider: input.sourceControlProvider,
        repository: input.repository,
        prNumber: input.prNumber,
        reviewHeadSha: input.reviewHeadSha,
        cycleId: input.cycleId,
        startedAt: input.observedAt,
      });
      return;
    }

    if (existing?.completedAt && existing.completedAt >= input.observedAt) {
      return;
    }
    await tx
      .insert(prReviewCycles)
      .values({
        sourceControlProvider: input.sourceControlProvider,
        repository: input.repository,
        prNumber: input.prNumber,
        reviewHeadSha: input.reviewHeadSha,
        cycleId: input.cycleId,
        // Legacy completed-cycle state has no recorded start. Treat its lower
        // bound as unknown so older findings from that completed pass cannot
        // be projected during migration.
        startedAt: existing?.startedAt ?? new Date(0),
        completedAt: input.observedAt,
      })
      .onConflictDoUpdate({
        target: [
          prReviewCycles.sourceControlProvider,
          prReviewCycles.repository,
          prReviewCycles.prNumber,
          prReviewCycles.reviewHeadSha,
          prReviewCycles.cycleId,
        ],
        set: { completedAt: input.observedAt },
      });
  });
}

export async function projectPendingPrReviewEventsForAssociation(
  executor: DatabaseOrTransaction,
  input: {
    taskId: string;
    sourceControlProvider: SourceControlProvider;
    repository: string;
    prNumber: number;
  },
): Promise<void> {
  await lockPrReviewReference(
    executor,
    input.sourceControlProvider,
    input.repository,
    input.prNumber,
  );
  const events = await executor
    .select({ id: prReviewEvents.id, availableAt: prReviewEvents.availableAt })
    .from(prReviewEvents)
    .where(
      and(
        reviewReference(input),
        eq(prReviewEvents.superseded, false),
        gte(
          prReviewEvents.observedAt,
          new Date(Date.now() - EVENT_ASSOCIATION_WINDOW_MS),
        ),
      ),
    );
  if (events.length === 0) return;

  await executor
    .insert(prReviewEventDeliveries)
    .values(
      events.map(({ id, availableAt }) => ({
        eventId: id,
        taskId: input.taskId,
        dueAt: availableAt,
      })),
    )
    .onConflictDoNothing();
}

export async function claimDuePrReviewDeliveries(
  now: Date = new Date(),
): Promise<ClaimedPrReviewDelivery[]> {
  return db.transaction(async (tx) => {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const nowIso = now.toISOString();
    const leaseExpiresAtIso = leaseExpiresAt.toISOString();
    const rows = await tx.execute<{
      id: string;
      task_id: string;
      deferrals: number;
      source_control_provider: SourceControlProvider;
      repository: string;
      pr_number: number;
      pr_url: string;
      batch_kind: 'human' | 'roomote';
      batch_id: string | null;
      event: Record<string, unknown>;
    }>(sql`
      with candidate_groups as (
        select d.task_id, e.source_control_provider, e.repository, e.pr_number,
               e.batch_kind, e.batch_id,
               max(e.event->>'automatedAuthorId') as automated_author_id,
               min(d.due_at) as first_due_at,
               min(d.created_at) as first_created_at
        from ${prReviewEventDeliveries} d
        join ${prReviewEvents} e on e.id = d.event_id
        where e.superseded = false
          and d.status in ('pending', 'processing')
        group by d.task_id, e.source_control_provider, e.repository, e.pr_number,
                 e.batch_kind, e.batch_id
        having bool_and(
          d.due_at <= ${nowIso}::timestamp
          and (
            d.status = 'pending'
            or (d.status = 'processing' and d.lease_expires_at <= ${nowIso}::timestamp)
          )
        )
      ), locked_groups as (
        select g.*
        from candidate_groups g
        where (
          g.automated_author_id is null
          or pg_try_advisory_xact_lock(
            hashtextextended(
              jsonb_build_array(
                'pr-review-automated-batch',
                g.source_control_provider,
                g.repository,
                g.pr_number::text,
                g.automated_author_id
              )::text,
              0
            )
          )
        )
        and pg_try_advisory_xact_lock(
          hashtextextended(
            jsonb_build_array(
              'pr-review-delivery',
              g.task_id,
              g.source_control_provider,
              g.repository,
              g.pr_number::text,
              g.batch_kind,
              coalesce(g.batch_id, '')
            )::text,
            0
          )
        )
        order by g.first_due_at, g.first_created_at
        limit ${CLAIM_LIMIT}
      ), sealed_events as (
        update ${prReviewEvents} e
        set sealed_at = coalesce(e.sealed_at, ${nowIso}::timestamp)
        from locked_groups g
        where g.automated_author_id is not null
          and e.source_control_provider = g.source_control_provider
          and e.repository = g.repository
          and e.pr_number = g.pr_number
          and e.batch_kind = g.batch_kind
          and e.batch_id is not distinct from g.batch_id
          and e.superseded = false
        returning e.id
      ), updated as (
        update ${prReviewEventDeliveries} d
        set status = 'processing', lease_token = ${leaseToken}, lease_expires_at = ${leaseExpiresAtIso}::timestamp
        from ${prReviewEvents} e, locked_groups g
        where d.event_id = e.id
          and d.task_id = g.task_id
          and e.source_control_provider = g.source_control_provider
          and e.repository = g.repository
          and e.pr_number = g.pr_number
          and e.batch_kind = g.batch_kind
          and e.batch_id is not distinct from g.batch_id
          and e.superseded = false
          and d.due_at <= ${nowIso}::timestamp
          and (
            d.status = 'pending'
            or (d.status = 'processing' and d.lease_expires_at <= ${nowIso}::timestamp)
          )
        returning d.id, d.event_id, d.task_id, d.deferrals
      )
      select u.id, u.task_id, u.deferrals, e.source_control_provider, e.repository,
             e.pr_number, e.pr_url, e.batch_kind, e.batch_id, e.event
      from updated u join ${prReviewEvents} e on e.id = u.event_id
      order by u.id
    `);

    const groups = new Map<string, ClaimedPrReviewDelivery>();
    for (const row of rows) {
      const key = [
        row.task_id,
        row.source_control_provider,
        row.repository,
        row.pr_number,
        row.batch_kind,
        row.batch_id ?? '',
      ].join('\0');
      const group = groups.get(key);
      if (group) {
        group.deliveryIds.push(row.id);
        group.events.push(row.event);
        group.deferrals = Math.max(group.deferrals, row.deferrals);
      } else {
        groups.set(key, {
          deliveryIds: [row.id],
          leaseToken,
          taskId: row.task_id,
          sourceControlProvider: row.source_control_provider,
          repository: row.repository,
          prNumber: row.pr_number,
          prUrl: row.pr_url,
          batchKind: row.batch_kind,
          batchId: row.batch_id,
          deferrals: row.deferrals,
          events: [row.event],
        });
      }
    }
    return [...groups.values()];
  });
}

async function updateClaimedDeliveries(
  claim: Pick<ClaimedPrReviewDelivery, 'deliveryIds' | 'leaseToken'>,
  values: Partial<typeof prReviewEventDeliveries.$inferInsert>,
): Promise<void> {
  await db
    .update(prReviewEventDeliveries)
    .set(values)
    .where(
      and(
        inArray(prReviewEventDeliveries.id, claim.deliveryIds),
        eq(prReviewEventDeliveries.leaseToken, claim.leaseToken),
      ),
    );
}

export async function completePrReviewDeliveries(
  claim: Pick<ClaimedPrReviewDelivery, 'deliveryIds' | 'leaseToken'>,
  status: 'delivered' | 'suppressed' = 'delivered',
): Promise<void> {
  await updateClaimedDeliveries(claim, {
    status,
    leaseToken: null,
    leaseExpiresAt: null,
  });
}

export async function renewPrReviewDeliveryClaim(
  claim: Pick<ClaimedPrReviewDelivery, 'deliveryIds' | 'leaseToken'>,
): Promise<boolean> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: prReviewEventDeliveries.id })
      .from(prReviewEventDeliveries)
      .where(
        and(
          inArray(prReviewEventDeliveries.id, claim.deliveryIds),
          eq(prReviewEventDeliveries.leaseToken, claim.leaseToken),
          eq(prReviewEventDeliveries.status, 'processing'),
          gt(prReviewEventDeliveries.leaseExpiresAt, now),
        ),
      )
      .for('update');

    if (rows.length !== claim.deliveryIds.length) return false;

    await tx
      .update(prReviewEventDeliveries)
      .set({ leaseExpiresAt })
      .where(
        and(
          inArray(prReviewEventDeliveries.id, claim.deliveryIds),
          eq(prReviewEventDeliveries.leaseToken, claim.leaseToken),
          eq(prReviewEventDeliveries.status, 'processing'),
        ),
      );
    return true;
  });
}

export async function deferPrReviewDeliveries(
  claim: Pick<ClaimedPrReviewDelivery, 'deliveryIds' | 'leaseToken'>,
  dueAt: Date,
): Promise<void> {
  await db
    .update(prReviewEventDeliveries)
    .set({
      status: 'pending',
      dueAt,
      deferrals: sql`${prReviewEventDeliveries.deferrals} + 1`,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        inArray(prReviewEventDeliveries.id, claim.deliveryIds),
        eq(prReviewEventDeliveries.leaseToken, claim.leaseToken),
      ),
    );
}

export async function releasePrReviewDeliveries(
  claim: Pick<ClaimedPrReviewDelivery, 'deliveryIds' | 'leaseToken'>,
): Promise<void> {
  await updateClaimedDeliveries(claim, {
    status: 'pending',
    leaseToken: null,
    leaseExpiresAt: null,
  });
}

export function buildPrReviewEventKey(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  event: Record<string, unknown>;
}): string {
  const providerEventId = input.event.providerEventId;
  return createHash('sha256')
    .update(
      JSON.stringify(
        typeof providerEventId === 'string' ? { providerEventId } : input.event,
      ),
    )
    .digest('hex');
}

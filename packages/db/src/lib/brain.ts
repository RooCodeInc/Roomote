import { and, count, desc, eq, inArray, lt, max, sql } from 'drizzle-orm';
import { RunStatus } from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import {
  brainCollectorItems,
  brainMemoryEvents,
  brainSyncState,
  taskRuns,
} from '../schema';

export type BrainSyncStateRow = typeof brainSyncState.$inferSelect;
export type BrainCollectorItemRow = typeof brainCollectorItems.$inferSelect;

export async function upsertBrainCollectorItems(
  database: DatabaseOrTransaction,
  collectorId: string,
  items: Array<{ itemId: string; slug: string; lastSeenAt: Date }>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  await database
    .insert(brainCollectorItems)
    .values(items.map((item) => ({ collectorId, ...item })))
    .onConflictDoUpdate({
      target: [brainCollectorItems.collectorId, brainCollectorItems.itemId],
      set: {
        slug: sql`excluded.slug`,
        lastSeenAt: sql`excluded.last_seen_at`,
        updatedAt: sql`now()`,
      },
    });
}

export async function listBrainCollectorItemsBefore(
  database: DatabaseOrTransaction,
  collectorId: string,
  before: Date,
  limit: number,
): Promise<BrainCollectorItemRow[]> {
  return database
    .select()
    .from(brainCollectorItems)
    .where(
      and(
        eq(brainCollectorItems.collectorId, collectorId),
        lt(brainCollectorItems.lastSeenAt, before),
      ),
    )
    .orderBy(brainCollectorItems.itemId)
    .limit(limit);
}

export async function listBrainCollectorItems(
  database: DatabaseOrTransaction,
  collectorId: string,
  limit: number,
): Promise<BrainCollectorItemRow[]> {
  return database
    .select()
    .from(brainCollectorItems)
    .where(eq(brainCollectorItems.collectorId, collectorId))
    .orderBy(brainCollectorItems.itemId)
    .limit(limit);
}

export async function deleteBrainCollectorItems(
  database: DatabaseOrTransaction,
  collectorId: string,
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) {
    return;
  }

  await database
    .delete(brainCollectorItems)
    .where(
      and(
        eq(brainCollectorItems.collectorId, collectorId),
        inArray(brainCollectorItems.itemId, itemIds),
      ),
    );
}

/**
 * Durable per-collector sync state: steady-state watermark plus deep-backfill
 * cursor/completion. Collectors read this at the start of a pass and persist
 * progress after pages land, so restarts and deploys never lose position.
 */
export async function getBrainSyncState(
  database: DatabaseOrTransaction,
  collectorId: string,
): Promise<BrainSyncStateRow | null> {
  const rows = await database
    .select()
    .from(brainSyncState)
    .where(eq(brainSyncState.collectorId, collectorId))
    .limit(1);

  return rows[0] ?? null;
}

export async function upsertBrainSyncState(
  database: DatabaseOrTransaction,
  collectorId: string,
  patch: {
    watermark?: Date | null;
    backfillCursor?: string | null;
    backfillCompletedAt?: Date | null;
  },
): Promise<void> {
  await database
    .insert(brainSyncState)
    .values({ collectorId, ...patch })
    .onConflictDoUpdate({
      target: brainSyncState.collectorId,
      set: { ...patch, updatedAt: sql`now()` },
    });
}

/**
 * Reset every durable ingestion checkpoint after the Brain corpus is
 * recreated. Collector cursors live in Roomote's database, not gbrain's, so
 * leaving them intact would make a fresh corpus look fully backfilled. Task
 * events need resetting in the same statement: their unique run ids prevent
 * the one-time history enqueue from creating replacement rows.
 *
 * Client provisioning is the reset boundary. A fresh gbrain database no
 * longer recognizes Roomote's stored OAuth clients, so successful
 * re-provisioning calls this before ingestion resumes.
 */
export async function resetBrainIngestionState(
  database: DatabaseOrTransaction,
): Promise<void> {
  await database.execute(sql`
    WITH reset_collector_items AS (
      DELETE FROM ${brainCollectorItems}
      RETURNING 1
    ), reset_sync_state AS (
      DELETE FROM ${brainSyncState}
      RETURNING 1
    )
    UPDATE ${brainMemoryEvents}
    SET
      status = 'pending',
      attempts = 0,
      last_error = NULL,
      processed_at = NULL,
      updated_at = now()
    WHERE run_id IN (
      SELECT id FROM ${taskRuns} WHERE status = 'completed'
    )
  `);
}

export type BrainMemoryEventRow = typeof brainMemoryEvents.$inferSelect;

/**
 * Transactional-outbox insert for a completed run's memory candidate. Called
 * inside the same transaction that marks the run Completed so the event and
 * the completion commit or roll back together. The unique(runId) constraint
 * plus onConflictDoNothing make replays (snapshot-resume re-finalization)
 * idempotent. Connection/credential resolution deliberately does NOT live
 * here: the drainer owns it, so the completion transaction stays a
 * single-row read plus a single-row insert.
 */
export async function maybeEnqueueBrainMemoryEvent(
  tx: DatabaseOrTransaction,
  runId: number,
): Promise<void> {
  await tx
    .insert(brainMemoryEvents)
    .values({ runId })
    .onConflictDoNothing({ target: brainMemoryEvents.runId });
}

/**
 * Record the narrative an agent wrote about its own work. The agent authors;
 * the server places: this only parks text on the run's outbox row, so the
 * drainer stays the single writer to the brain and the per-run slug,
 * redaction, and provenance remain server-controlled.
 *
 * Status resets to 'pending' so a memory already ingested is re-written with
 * richer content at the same run-specific slug, and the row is
 * created if the run has not finished yet — the completion path's
 * onConflictDoNothing then leaves this summary intact.
 */
export async function saveBrainAgentSummary(
  database: DatabaseOrTransaction,
  runId: number,
  agentSummary: string,
): Promise<void> {
  await database
    .insert(brainMemoryEvents)
    .values({ runId, agentSummary })
    .onConflictDoUpdate({
      target: brainMemoryEvents.runId,
      set: {
        agentSummary,
        status: 'pending',
        attempts: 0,
        lastError: null,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Backfill: enqueue outbox events for every already-completed run, so
 * connecting the brain sucks in the deployment's task history rather than
 * only learning from tasks completed after enablement. Idempotent via the
 * unique(runId) constraint; the drainer distills the backlog batch by batch.
 */
export async function backfillBrainMemoryEvents(
  database: DatabaseOrTransaction,
  options: { requeueCompleted?: boolean } = {},
): Promise<number> {
  const requeued = options.requeueCompleted
    ? ((await database.execute(
        sql`UPDATE ${brainMemoryEvents} AS event
            SET status = 'pending', attempts = 0, last_error = NULL, updated_at = now()
            FROM ${taskRuns} AS run
            WHERE event.run_id = run.id
              AND event.status = 'done'
              AND run.status = 'completed'
            RETURNING event.id`,
      )) as unknown as Array<{ id: string }>)
    : [];
  const rows = (await database.execute(
    sql`INSERT INTO ${brainMemoryEvents} (run_id)
        SELECT id FROM ${taskRuns} WHERE status = 'completed'
        ON CONFLICT (run_id) DO NOTHING
        RETURNING id`,
  )) as unknown as Array<{ id: string }>;

  return requeued.length + rows.length;
}

/**
 * A claim that never gets marked is stranded: 'processing' rows are invisible
 * to later claims, so without this they would sit forever. Reclaim after this
 * long, which must stay comfortably above the drainer's worst-case tick.
 */
const PROCESSING_RECLAIM_INTERVAL = '15 minutes';

/**
 * Claim up to `limit` outbox events for processing. Uses FOR UPDATE SKIP
 * LOCKED so concurrent drainers never double-claim, and flips claimed rows to
 * 'processing' in the same statement.
 *
 * Stale 'processing' rows are claimed alongside pending ones: a drainer that
 * dies mid-batch (crash, deploy, or the rate-limit path returning before the
 * batch is done) leaves rows it claimed but never marked, and those must come
 * back rather than silently drop the memory. Their attempts counter keeps
 * climbing across reclaims, so a row that poisons the drainer still reaches
 * MAX_ATTEMPTS instead of cycling forever.
 *
 * Newer completed runs are claimed first so a large historical backfill makes
 * the Brain useful for recent work immediately. Run ID breaks timestamp ties.
 */
export async function claimPendingBrainMemoryEvents(
  database: DatabaseOrTransaction,
  limit: number,
): Promise<BrainMemoryEventRow[]> {
  const rows = await database
    .update(brainMemoryEvents)
    .set({
      status: 'processing',
      attempts: sql`${brainMemoryEvents.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      sql`${brainMemoryEvents.id} IN (
        SELECT event.id
        FROM ${brainMemoryEvents} AS event
        LEFT JOIN ${taskRuns} AS run ON run.id = event.run_id
        WHERE event.status = 'pending'
           OR (
             event.status = 'processing'
             AND event.updated_at < now() - ${sql.raw(`interval '${PROCESSING_RECLAIM_INTERVAL}'`)}
           )
        ORDER BY run.completed_at DESC NULLS LAST, event.run_id DESC
        LIMIT ${limit}
        FOR UPDATE OF event SKIP LOCKED
      )`,
    )
    .returning();

  return rows;
}

/**
 * Hand back events claimed but not processed, so the next tick picks them up
 * immediately instead of waiting out the reclaim interval. The attempt is
 * refunded because it never happened: backpressure is not a failed try.
 */
export async function releaseBrainMemoryEvents(
  database: DatabaseOrTransaction,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await database
    .update(brainMemoryEvents)
    .set({
      status: 'pending',
      attempts: sql`greatest(${brainMemoryEvents.attempts} - 1, 0)`,
      updatedAt: sql`now()`,
    })
    .where(inArray(brainMemoryEvents.id, ids));
}

export type BrainMemoryEventStatus = BrainMemoryEventRow['status'];

export type BrainMemoryEventSummary = {
  byStatus: Record<BrainMemoryEventStatus, number>;
  /** Most recent successful (or deliberately skipped) ingestion. */
  lastProcessedAt: Date | null;
  /** Error text from the most recently updated terminal failure, if any. */
  lastError: string | null;
  /**
   * Completed runs that never got an outbox row. Non-zero means task history
   * predates the Brain (or a backfill has not been run), which is a state an
   * admin can act on rather than a fault.
   */
  completedRunsWithoutEvent: number;
};

const EMPTY_MEMORY_EVENT_STATUS_COUNTS: Record<BrainMemoryEventStatus, number> =
  {
    pending: 0,
    processing: 0,
    done: 0,
    skipped: 0,
    failed: 0,
  };

/**
 * Read-only rollup of the task-memory outbox for the Brain settings page.
 * Kept as one function so the page renders a single consistent picture rather
 * than a set of counts read at drifting moments.
 */
export async function getBrainMemoryEventSummary(
  database: DatabaseOrTransaction,
): Promise<BrainMemoryEventSummary> {
  const [statusRows, processedRow, failureRow, missingRow] = await Promise.all([
    database
      .select({
        status: brainMemoryEvents.status,
        total: count(),
      })
      .from(brainMemoryEvents)
      .groupBy(brainMemoryEvents.status),
    database
      .select({ lastProcessedAt: max(brainMemoryEvents.processedAt) })
      .from(brainMemoryEvents),
    database
      .select({ lastError: brainMemoryEvents.lastError })
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.status, 'failed'))
      .orderBy(desc(brainMemoryEvents.updatedAt))
      .limit(1),
    database
      .select({ total: count() })
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.status, RunStatus.Completed),
          sql`NOT EXISTS (
            SELECT 1 FROM ${brainMemoryEvents}
            WHERE ${brainMemoryEvents.runId} = ${taskRuns.id}
          )`,
        ),
      ),
  ]);

  const byStatus = { ...EMPTY_MEMORY_EVENT_STATUS_COUNTS };

  for (const row of statusRows) {
    byStatus[row.status] = row.total;
  }

  return {
    byStatus,
    lastProcessedAt: processedRow[0]?.lastProcessedAt ?? null,
    lastError: failureRow[0]?.lastError ?? null,
    completedRunsWithoutEvent: missingRow[0]?.total ?? 0,
  };
}

/**
 * Hand exhausted memories back to the drainer. Attempts reset to zero on
 * purpose: a retry an admin asked for is a fresh budget, not a continuation of
 * the one that ran out, and the usual cause is an outage that has since been
 * fixed rather than a poison row.
 */
export async function requeueFailedBrainMemoryEvents(
  database: DatabaseOrTransaction,
): Promise<number> {
  const rows = await database
    .update(brainMemoryEvents)
    .set({
      status: 'pending',
      attempts: 0,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(eq(brainMemoryEvents.status, 'failed'))
    .returning({ id: brainMemoryEvents.id });

  return rows.length;
}

/** Every durable collector checkpoint, including per-partition rows. */
export async function listBrainSyncStates(
  database: DatabaseOrTransaction,
): Promise<BrainSyncStateRow[]> {
  return database
    .select()
    .from(brainSyncState)
    .orderBy(brainSyncState.collectorId);
}

/** Tracked upstream objects per collector, for reporting inventory size. */
export async function countBrainCollectorItemsByCollector(
  database: DatabaseOrTransaction,
): Promise<Array<{ collectorId: string; items: number }>> {
  return database
    .select({
      collectorId: brainCollectorItems.collectorId,
      items: count(),
    })
    .from(brainCollectorItems)
    .groupBy(brainCollectorItems.collectorId);
}

export async function markBrainMemoryEvent(
  database: DatabaseOrTransaction,
  id: string,
  status: 'pending' | 'done' | 'skipped' | 'failed',
  lastError?: string,
): Promise<void> {
  await database
    .update(brainMemoryEvents)
    .set({
      status,
      lastError: lastError ?? null,
      processedAt:
        status === 'done' || status === 'skipped' ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(brainMemoryEvents.id, id));
}

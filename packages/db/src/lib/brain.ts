import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  lte,
  max,
  or,
  sql,
} from 'drizzle-orm';
import {
  BRAIN_COLLECTOR_IDS,
  MISSING_MEMORY_EVENT_COUNT_CAP,
  RunStatus,
} from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import {
  brainCollectorItems,
  brainMemoryEvents,
  brainSyncState,
  taskRuns,
} from '../schema';
import { runInTransactionIfAvailable } from './transaction-utils';

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

/**
 * Rewrite a slug-keyed collector's inventory rows to their lowercase form,
 * merging case-duplicates by keeping the freshest lastSeenAt. gbrain
 * canonicalizes slugs to lowercase before a page row is written, so an
 * inventory row tracked under a mixed-case slug names a page the corpus
 * never stores. Returns how many mixed-case rows were rewritten (0 when the
 * inventory is already canonical, which makes this cheap to run every pass).
 */
export async function canonicalizeBrainCollectorItemSlugs(
  database: DatabaseOrTransaction,
  collectorId: string,
): Promise<number> {
  const mixedCase = and(
    eq(brainCollectorItems.collectorId, collectorId),
    sql`${brainCollectorItems.itemId} <> lower(${brainCollectorItems.itemId})`,
  );
  const [row] = await database
    .select({ mixed: count() })
    .from(brainCollectorItems)
    .where(mixedCase);
  const mixed = row?.mixed ?? 0;

  if (mixed === 0) {
    return 0;
  }

  // Insert the canonical rows first, then drop the originals: a crash in
  // between leaves both forms present and the next pass finishes the job.
  await database.execute(sql`
    INSERT INTO ${brainCollectorItems} (collector_id, item_id, slug, last_seen_at)
    SELECT collector_id, lower(item_id), lower(item_id), max(last_seen_at)
    FROM ${brainCollectorItems}
    WHERE collector_id = ${collectorId} AND item_id <> lower(item_id)
    GROUP BY collector_id, lower(item_id)
    ON CONFLICT (collector_id, item_id) DO UPDATE SET
      last_seen_at = GREATEST(${brainCollectorItems}.last_seen_at, excluded.last_seen_at),
      updated_at = now()
  `);
  await database.delete(brainCollectorItems).where(mixedCase);

  return mixed;
}

/**
 * Canonicalize a slug inventory and, when rows changed, reset the replay that
 * must revisit it. Both mutations commit together so a process exit cannot
 * leave canonical rows behind with the old replay cursor still completed.
 */
export async function canonicalizeBrainCollectorItemSlugsAndResetSyncState(
  database: DatabaseOrTransaction,
  collectorId: string,
  syncStateCollectorId: string,
): Promise<number> {
  return runInTransactionIfAvailable(database, async (tx) => {
    const rewritten = await canonicalizeBrainCollectorItemSlugs(
      tx,
      collectorId,
    );

    if (rewritten > 0) {
      await upsertBrainSyncState(tx, syncStateCollectorId, {
        backfillCursor: null,
        backfillCompletedAt: null,
      });
    }

    return rewritten;
  });
}

/**
 * Delete one collector's sync-state row together with every `:`-suffixed
 * child row (per-channel or per-repository partitions). Used to drop the
 * rows a collector version bump superseded, which otherwise linger forever
 * and pollute anything that aggregates a source's partitions.
 */
export async function deleteBrainSyncStateFamily(
  database: DatabaseOrTransaction,
  collectorId: string,
): Promise<void> {
  await database
    .delete(brainSyncState)
    .where(
      sql`${brainSyncState.collectorId} = ${collectorId} OR ${brainSyncState.collectorId} LIKE ${`${collectorId.replace(/[\\%_]/g, (ch) => `\\${ch}`)}:%`}`,
    );
}

/**
 * Move one collector family's sync-state rows under a new id prefix,
 * preserving watermarks and cursors. Used when a per-partition id drifted
 * from its collector id (a hardcoded superseded version): renaming keeps the
 * partitions' positions instead of forcing a re-read. Rows whose new id
 * already exists are dropped in favor of the newer writer's row.
 */
export async function renameBrainSyncStateFamilyPrefix(
  database: DatabaseOrTransaction,
  fromCollectorId: string,
  toCollectorId: string,
): Promise<void> {
  const likePrefix = `${fromCollectorId.replace(/[\\%_]/g, (ch) => `\\${ch}`)}:%`;

  // Insert-then-delete, like canonicalizeBrainCollectorItemSlugs: a crash in
  // between leaves both rows and the next pass finishes the job.
  await database.execute(sql`
    INSERT INTO ${brainSyncState} (collector_id, watermark, backfill_cursor, backfill_completed_at)
    SELECT ${toCollectorId} || substr(collector_id, ${fromCollectorId.length + 1}),
      watermark, backfill_cursor, backfill_completed_at
    FROM ${brainSyncState}
    WHERE collector_id LIKE ${likePrefix}
    ON CONFLICT (collector_id) DO NOTHING
  `);
  await database
    .delete(brainSyncState)
    .where(like(brainSyncState.collectorId, likePrefix));
}

/**
 * Record inventory rows without touching ones that already exist. This is the
 * census path: a one-time walk over the Brain's listing seeds pages emitted
 * before item tracking existed, and must never overwrite the fresher
 * lastSeenAt a live collector wrote for the same slug.
 */
export async function seedBrainCollectorItems(
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
    .onConflictDoNothing({
      target: [brainCollectorItems.collectorId, brainCollectorItems.itemId],
    });
}

/**
 * Inventory rows whose itemId starts with a literal prefix. gbrain's
 * list_pages has no slug-prefix filter, so collectors that key items by slug
 * (itemId = slug) use this local inventory to find the pages they previously
 * emitted under a namespace, e.g. one Slack channel-day.
 */
export async function listBrainCollectorItemsBySlugPrefix(
  database: DatabaseOrTransaction,
  collectorId: string,
  slugPrefix: string,
  limit: number,
): Promise<BrainCollectorItemRow[]> {
  const literalPrefix = slugPrefix.replace(/[\\%_]/g, (char) => `\\${char}`);

  return database
    .select()
    .from(brainCollectorItems)
    .where(
      and(
        eq(brainCollectorItems.collectorId, collectorId),
        like(brainCollectorItems.itemId, `${literalPrefix}%`),
      ),
    )
    .orderBy(brainCollectorItems.itemId)
    .limit(limit);
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
 * Every save bumps `revision`, which the drainer fences its completion on.
 * A settled row ('done'/'skipped'/'failed') returns to 'pending' with a fresh
 * retry budget so the richer content re-ingests at the same run-specific
 * slug, and the row is created if the run has not finished yet — the
 * completion path's onConflictDoNothing then leaves this summary intact. A
 * row the drainer currently holds ('processing') keeps its status and budget:
 * leaving it claimed guarantees a single in-flight page writer per run, and
 * the drainer's revision fence hands the row back when its snapshot went
 * stale mid-write.
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
        revision: sql`${brainMemoryEvents.revision} + 1`,
        status: sql`case when ${brainMemoryEvents.status} = 'processing' then 'processing' else 'pending' end`,
        attempts: sql`case when ${brainMemoryEvents.status} = 'processing' then ${brainMemoryEvents.attempts} else 0 end`,
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
  historicalCompletedRunsWithoutEvent: number;
  /** Completed after the one-time backfill but missing their automatic row. */
  recentCompletedRunsWithoutEvent: number;
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
  const taskMemoryState = await getBrainSyncState(
    database,
    BRAIN_COLLECTOR_IDS.taskMemories,
  );
  const historyCutoff = taskMemoryState?.backfillCompletedAt ?? null;
  const missingEvent = sql`NOT EXISTS (
    SELECT 1 FROM ${brainMemoryEvents}
    WHERE ${brainMemoryEvents.runId} = ${taskRuns.id}
  )`;
  const [
    statusRows,
    processedRow,
    failureRow,
    historicalMissingRows,
    recentMissingRows,
  ] = await Promise.all([
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
    // Before the first backfill checkpoint, every missing row is history. Once
    // it exists, only runs completed on or before it belong in that banner.
    database
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.status, RunStatus.Completed),
          missingEvent,
          historyCutoff
            ? or(
                isNull(taskRuns.completedAt),
                lte(taskRuns.completedAt, historyCutoff),
              )
            : undefined,
        ),
      )
      .limit(MISSING_MEMORY_EVENT_COUNT_CAP),
    historyCutoff
      ? database
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.status, RunStatus.Completed),
              gt(taskRuns.completedAt, historyCutoff),
              missingEvent,
            ),
          )
          .limit(MISSING_MEMORY_EVENT_COUNT_CAP)
      : Promise.resolve([]),
  ]);

  const byStatus = { ...EMPTY_MEMORY_EVENT_STATUS_COUNTS };

  for (const row of statusRows) {
    byStatus[row.status] = row.total;
  }

  return {
    byStatus,
    lastProcessedAt: processedRow[0]?.lastProcessedAt ?? null,
    lastError: failureRow[0]?.lastError ?? null,
    historicalCompletedRunsWithoutEvent: historicalMissingRows.length,
    recentCompletedRunsWithoutEvent: recentMissingRows.length,
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

/**
 * Non-terminal transitions. 'pending' hands a claimed row back unguarded;
 * 'skipped' (the run no longer exists or settled without completing) applies
 * only while the row is still 'processing', so a concurrent reclaim is not
 * clobbered.
 */
export async function markBrainMemoryEvent(
  database: DatabaseOrTransaction,
  id: string,
  status: 'pending' | 'skipped',
  lastError?: string,
): Promise<void> {
  await database
    .update(brainMemoryEvents)
    .set({
      status,
      lastError: lastError ?? null,
      processedAt: status === 'skipped' ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(
      status === 'pending'
        ? eq(brainMemoryEvents.id, id)
        : and(
            eq(brainMemoryEvents.id, id),
            eq(brainMemoryEvents.status, 'processing'),
          ),
    );
}

/**
 * Settle a claimed event after the page write, fenced on the revision the
 * drainer claimed. The fence is what makes overlapping writers safe: gbrain
 * page writes carry no timeout, so an older in-flight `put_page` can land
 * after a newer one. Whichever writer holds a stale revision (or lost its
 * claim to a stale-reclaim) fails the fence, and the row is handed back to
 * 'pending' — the forced re-ingest both carries the newer summary and re-puts
 * the latest content over whatever snapshot reached the page last.
 */
export async function settleBrainMemoryEvent(
  database: DatabaseOrTransaction,
  id: string,
  claimedRevision: number,
  outcome: 'done' | 'failed',
  lastError?: string,
): Promise<'settled' | 'superseded'> {
  const settled = await database
    .update(brainMemoryEvents)
    .set({
      status: outcome,
      lastError: lastError ?? null,
      processedAt: outcome === 'done' ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(brainMemoryEvents.id, id),
        eq(brainMemoryEvents.status, 'processing'),
        eq(brainMemoryEvents.revision, claimedRevision),
      ),
    )
    .returning({ id: brainMemoryEvents.id });

  if (settled.length > 0) {
    return 'settled';
  }

  await database
    .update(brainMemoryEvents)
    .set({ status: 'pending', updatedAt: sql`now()` })
    .where(
      and(
        eq(brainMemoryEvents.id, id),
        eq(brainMemoryEvents.status, 'processing'),
      ),
    );

  return 'superseded';
}

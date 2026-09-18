import { eq, inArray, sql } from 'drizzle-orm';
import { taskMemorySlug } from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { brainMemoryEvents, brainPageRetirements, taskRuns } from '../schema';
import { createMemoryOutboxLifecycle } from './memory-outbox-lifecycle';

export type BrainPageRetirementRow = typeof brainPageRetirements.$inferSelect;

const lifecycle =
  createMemoryOutboxLifecycle<BrainPageRetirementRow>(brainPageRetirements);
const PROCESSING_RECLAIM_INTERVAL = '15 minutes';

export async function enqueueBrainPageRetirements(
  database: DatabaseOrTransaction,
  slugs: string[],
): Promise<void> {
  const uniqueSlugs = [...new Set(slugs)];
  if (uniqueSlugs.length === 0) return;

  await database
    .insert(brainPageRetirements)
    .values(uniqueSlugs.map((slug) => ({ slug })))
    .onConflictDoUpdate({
      target: brainPageRetirements.slug,
      set: {
        revision: sql`${brainPageRetirements.revision} + 1`,
        status: sql`case when ${brainPageRetirements.status} = 'processing' then 'processing' else 'pending' end`,
        attempts: sql`case when ${brainPageRetirements.status} = 'processing' then ${brainPageRetirements.attempts} else 0 end`,
        lastError: null,
        processedAt: null,
        updatedAt: sql`now()`,
      },
    });
}

/** Re-arm an existing tombstone after a racing page write. */
export async function rearmBrainPageRetirement(
  database: DatabaseOrTransaction,
  slug: string,
): Promise<void> {
  await database
    .update(brainPageRetirements)
    .set({
      revision: sql`${brainPageRetirements.revision} + 1`,
      status: sql`case when ${brainPageRetirements.status} = 'processing' then 'processing' else 'pending' end`,
      attempts: sql`case when ${brainPageRetirements.status} = 'processing' then ${brainPageRetirements.attempts} else 0 end`,
      lastError: null,
      processedAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(brainPageRetirements.slug, slug));
}

/**
 * Snapshot every run-owned task page before deletion and stop queued writers.
 * The exact slugs preserve unrelated collector pages and broader summaries.
 */
export async function enqueueTaskMemoryRetirements(
  database: DatabaseOrTransaction,
  taskIds: string[],
): Promise<void> {
  if (taskIds.length === 0) return;

  const rows = await database
    .select({
      eventId: brainMemoryEvents.id,
      taskId: taskRuns.taskId,
      runId: taskRuns.id,
    })
    .from(brainMemoryEvents)
    .innerJoin(taskRuns, eq(taskRuns.id, brainMemoryEvents.runId))
    .where(inArray(taskRuns.taskId, taskIds));

  await enqueueBrainPageRetirements(
    database,
    rows.map((row) => taskMemorySlug(row.taskId, row.runId)),
  );

  if (rows.length > 0) {
    await database
      .update(brainMemoryEvents)
      .set({
        status: 'skipped',
        revision: sql`${brainMemoryEvents.revision} + 1`,
        agentSummary: null,
        lastError: 'task deleted',
        processedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        inArray(
          brainMemoryEvents.id,
          rows.map((row) => row.eventId),
        ),
      );
  }
}

export async function claimPendingBrainPageRetirements(
  database: DatabaseOrTransaction,
  limit: number,
): Promise<BrainPageRetirementRow[]> {
  return lifecycle.claim(
    database,
    sql`
      SELECT retirement.id
      FROM ${brainPageRetirements} AS retirement
      WHERE retirement.status = 'pending'
         OR (
           retirement.status = 'processing'
           AND retirement.updated_at < now() - ${sql.raw(`interval '${PROCESSING_RECLAIM_INTERVAL}'`)}
         )
      ORDER BY retirement.created_at, retirement.id
      LIMIT ${limit}
      FOR UPDATE OF retirement SKIP LOCKED
    `,
  );
}

export async function releaseBrainPageRetirements(
  database: DatabaseOrTransaction,
  ids: string[],
): Promise<void> {
  await lifecycle.release(database, ids);
}

export async function markBrainPageRetirement(
  database: DatabaseOrTransaction,
  id: string,
  status: 'pending' | 'skipped',
  lastError?: string,
): Promise<void> {
  await lifecycle.mark(database, id, status, lastError);
}

export async function settleBrainPageRetirement(
  database: DatabaseOrTransaction,
  id: string,
  claimedRevision: number,
  outcome: 'done' | 'failed',
  lastError?: string,
): Promise<'settled' | 'superseded'> {
  return lifecycle.settle(database, id, claimedRevision, outcome, lastError);
}

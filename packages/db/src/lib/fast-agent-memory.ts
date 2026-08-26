import { eq, inArray, sql } from 'drizzle-orm';
import { FAST_AGENT_MEMORY_MAX_CHARS } from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { fastAgentMemoryEvents } from '../schema';
import { runInTransactionIfAvailable } from './transaction-utils';

export type FastAgentMemoryEventRow = typeof fastAgentMemoryEvents.$inferSelect;

const PROCESSING_RECLAIM_INTERVAL = '15 minutes';

export type AppendFastAgentMemoryResult =
  | { saved: true }
  | { saved: false; reason: 'memory_full' };

/**
 * Append one remembered fact to a conversation's memory outbox row. The agent
 * authors the fact; the server places it: the row is drained by the Brain
 * ingestion pipeline, which owns the slug, redaction, and provenance, so Fast
 * never reaches the Brain directly.
 *
 * Status resets to 'pending' so an already-ingested memory is re-written with
 * the richer content at the same conversation-specific slug.
 */
export async function appendFastAgentMemory(
  database: DatabaseOrTransaction,
  conversationId: string,
  fact: string,
): Promise<AppendFastAgentMemoryResult> {
  const line = `- ${fact.trim()}`;

  return runInTransactionIfAvailable(database, async (tx) => {
    const [existing] = await tx
      .select({ memory: fastAgentMemoryEvents.memory })
      .from(fastAgentMemoryEvents)
      .where(eq(fastAgentMemoryEvents.conversationId, conversationId))
      .for('update');

    if (
      existing &&
      existing.memory.length + line.length + 1 > FAST_AGENT_MEMORY_MAX_CHARS
    ) {
      return { saved: false, reason: 'memory_full' };
    }

    await tx
      .insert(fastAgentMemoryEvents)
      .values({ conversationId, memory: line })
      .onConflictDoUpdate({
        target: fastAgentMemoryEvents.conversationId,
        set: {
          memory: sql`${fastAgentMemoryEvents.memory} || E'\n' || ${line}`,
          status: 'pending',
          attempts: 0,
          lastError: null,
          updatedAt: sql`now()`,
        },
      });

    return { saved: true };
  });
}

/**
 * Claim up to `limit` conversation-memory events for processing. Mirrors
 * claimPendingBrainMemoryEvents: FOR UPDATE SKIP LOCKED so concurrent
 * drainers never double-claim, stale 'processing' rows come back after the
 * reclaim interval, and attempts climb across reclaims so a poisonous row
 * still terminates. Most recently updated first: the freshest memories are
 * the ones a next conversation is most likely to need.
 */
export async function claimPendingFastAgentMemoryEvents(
  database: DatabaseOrTransaction,
  limit: number,
): Promise<FastAgentMemoryEventRow[]> {
  const rows = await database
    .update(fastAgentMemoryEvents)
    .set({
      status: 'processing',
      attempts: sql`${fastAgentMemoryEvents.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      sql`${fastAgentMemoryEvents.id} IN (
        SELECT event.id
        FROM ${fastAgentMemoryEvents} AS event
        WHERE event.status = 'pending'
           OR (
             event.status = 'processing'
             AND event.updated_at < now() - ${sql.raw(`interval '${PROCESSING_RECLAIM_INTERVAL}'`)}
           )
        ORDER BY event.updated_at DESC, event.id DESC
        LIMIT ${limit}
        FOR UPDATE OF event SKIP LOCKED
      )`,
    )
    .returning();

  return rows;
}

/**
 * Hand back events claimed but not processed, refunding the attempt:
 * backpressure is not a failed try.
 */
export async function releaseFastAgentMemoryEvents(
  database: DatabaseOrTransaction,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await database
    .update(fastAgentMemoryEvents)
    .set({
      status: 'pending',
      attempts: sql`greatest(${fastAgentMemoryEvents.attempts} - 1, 0)`,
      updatedAt: sql`now()`,
    })
    .where(inArray(fastAgentMemoryEvents.id, ids));
}

export async function markFastAgentMemoryEvent(
  database: DatabaseOrTransaction,
  id: string,
  status: 'pending' | 'done' | 'skipped' | 'failed',
  lastError?: string,
): Promise<void> {
  await database
    .update(fastAgentMemoryEvents)
    .set({
      status,
      lastError: lastError ?? null,
      processedAt:
        status === 'done' || status === 'skipped' ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(fastAgentMemoryEvents.id, id));
}

import { and, eq, inArray, sql } from 'drizzle-orm';
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
 * Every append bumps `revision`, which the drainer fences its completion on.
 * A settled row ('done'/'skipped'/'failed') returns to 'pending' with a fresh
 * retry budget so the richer content re-ingests at the same slug. A row the
 * drainer currently holds ('processing') keeps its status and budget: leaving
 * it claimed guarantees a single in-flight page writer per conversation, and
 * the drainer's revision fence hands the row back when its snapshot went
 * stale mid-write.
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
          revision: sql`${fastAgentMemoryEvents.revision} + 1`,
          status: sql`case when ${fastAgentMemoryEvents.status} = 'processing' then 'processing' else 'pending' end`,
          attempts: sql`case when ${fastAgentMemoryEvents.status} = 'processing' then ${fastAgentMemoryEvents.attempts} else 0 end`,
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

/**
 * Non-terminal transitions. 'pending' hands a claimed row back unguarded;
 * 'skipped' (the conversation no longer exists) applies only while the row is
 * still 'processing', so a concurrent reclaim is not clobbered.
 */
export async function markFastAgentMemoryEvent(
  database: DatabaseOrTransaction,
  id: string,
  status: 'pending' | 'skipped',
  lastError?: string,
): Promise<void> {
  await database
    .update(fastAgentMemoryEvents)
    .set({
      status,
      lastError: lastError ?? null,
      processedAt: status === 'skipped' ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(
      status === 'pending'
        ? eq(fastAgentMemoryEvents.id, id)
        : and(
            eq(fastAgentMemoryEvents.id, id),
            eq(fastAgentMemoryEvents.status, 'processing'),
          ),
    );
}

/**
 * Settle a claimed event after the page write, fenced on the revision the
 * drainer claimed. The fence is what makes overlapping writers safe: gbrain
 * page writes carry no timeout, so an older in-flight `put_page` can land
 * after a newer one. Whichever writer holds a stale revision (or lost its
 * claim to a stale-reclaim) fails the fence, and the row is handed back to
 * 'pending' — the forced re-ingest both carries any newer facts and re-puts
 * the latest content over whatever snapshot reached the page last.
 */
export async function settleFastAgentMemoryEvent(
  database: DatabaseOrTransaction,
  id: string,
  claimedRevision: number,
  outcome: 'done' | 'failed',
  lastError?: string,
): Promise<'settled' | 'superseded'> {
  const settled = await database
    .update(fastAgentMemoryEvents)
    .set({
      status: outcome,
      lastError: lastError ?? null,
      processedAt: outcome === 'done' ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(fastAgentMemoryEvents.id, id),
        eq(fastAgentMemoryEvents.status, 'processing'),
        eq(fastAgentMemoryEvents.revision, claimedRevision),
      ),
    )
    .returning({ id: fastAgentMemoryEvents.id });

  if (settled.length > 0) {
    return 'settled';
  }

  await database
    .update(fastAgentMemoryEvents)
    .set({ status: 'pending', updatedAt: sql`now()` })
    .where(
      and(
        eq(fastAgentMemoryEvents.id, id),
        eq(fastAgentMemoryEvents.status, 'processing'),
      ),
    );

  return 'superseded';
}

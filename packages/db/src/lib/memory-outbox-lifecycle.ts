import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';

import { type DatabaseOrTransaction } from '../db';

type MemoryOutboxTable = AnyPgTable & {
  id: AnyPgColumn;
  status: AnyPgColumn;
  attempts: AnyPgColumn;
  revision: AnyPgColumn;
  lastError: AnyPgColumn;
  processedAt: AnyPgColumn;
  updatedAt: AnyPgColumn;
};

export type MemoryOutboxLifecycle<TRow> = {
  claim(database: DatabaseOrTransaction, candidateIds: SQL): Promise<TRow[]>;
  release(database: DatabaseOrTransaction, ids: string[]): Promise<void>;
  mark(
    database: DatabaseOrTransaction,
    id: string,
    status: 'pending' | 'skipped',
    lastError?: string,
  ): Promise<void>;
  settle(
    database: DatabaseOrTransaction,
    id: string,
    claimedRevision: number,
    outcome: 'done' | 'failed',
    lastError?: string,
  ): Promise<'settled' | 'superseded'>;
};

/**
 * Shared durable transitions for revision-fenced memory outboxes. Candidate
 * selection remains with each domain so task and conversation ordering can
 * evolve independently without duplicating the state machine.
 */
export function createMemoryOutboxLifecycle<TRow>(
  table: MemoryOutboxTable,
): MemoryOutboxLifecycle<TRow> {
  return {
    async claim(database, candidateIds) {
      return database
        .update(table)
        .set({
          status: 'processing',
          attempts: sql`${table.attempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(sql`${table.id} IN (${candidateIds})`)
        .returning() as Promise<TRow[]>;
    },

    async release(database, ids) {
      if (ids.length === 0) {
        return;
      }

      await database
        .update(table)
        .set({
          status: 'pending',
          attempts: sql`greatest(${table.attempts} - 1, 0)`,
          updatedAt: sql`now()`,
        })
        .where(inArray(table.id, ids));
    },

    async mark(database, id, status, lastError) {
      await database
        .update(table)
        .set({
          status,
          lastError: lastError ?? null,
          processedAt: status === 'skipped' ? sql`now()` : null,
          updatedAt: sql`now()`,
        })
        .where(
          status === 'pending'
            ? eq(table.id, id)
            : and(eq(table.id, id), eq(table.status, 'processing')),
        );
    },

    async settle(database, id, claimedRevision, outcome, lastError) {
      const settled = await database
        .update(table)
        .set({
          status: outcome,
          lastError: lastError ?? null,
          processedAt: outcome === 'done' ? sql`now()` : null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(table.id, id),
            eq(table.status, 'processing'),
            eq(table.revision, claimedRevision),
          ),
        )
        .returning({ id: table.id });

      if (settled.length > 0) {
        return 'settled';
      }

      // A late stale writer may have overwritten a newer external page. The
      // unconditional requeue guarantees the latest revision is put again.
      await database
        .update(table)
        .set({ status: 'pending', processedAt: null, updatedAt: sql`now()` })
        .where(eq(table.id, id));

      return 'superseded';
    },
  };
}

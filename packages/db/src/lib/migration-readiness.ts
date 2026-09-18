import { sql } from 'drizzle-orm';

import journal from '../../drizzle/meta/_journal.json';
import type { DatabaseOrTransaction } from '../db';

/**
 * The newest migration this build expects, as drizzle records it: the
 * migrator writes each entry's journal `when` into
 * `drizzle.__drizzle_migrations.created_at`.
 */
export const LATEST_MIGRATION_MILLIS = journal.entries.reduce(
  (latest, entry) => Math.max(latest, entry.when),
  0,
);
export const LATEST_MIGRATION_TAG =
  journal.entries.find((entry) => entry.when === LATEST_MIGRATION_MILLIS)
    ?.tag ?? null;

export type MigrationReadiness =
  | { state: 'ready'; appliedMillis: number }
  | { state: 'pending'; appliedMillis: number | null }
  /** Tables exist but no drizzle bookkeeping: the schema is pushed directly (dev, tests). */
  | { state: 'unmanaged' };

const MISSING_RELATION_CODES = new Set(['42P01', '3F000']);

function isMissingRelationError(error: unknown): boolean {
  const code =
    (error as { code?: unknown })?.code ??
    (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === 'string' && MISSING_RELATION_CODES.has(code);
}

export async function checkMigrationReadiness(
  database: DatabaseOrTransaction,
): Promise<MigrationReadiness> {
  let appliedMillis: number | null = null;
  try {
    const rows = (await database.execute(
      sql`select max(created_at) as applied from drizzle.__drizzle_migrations`,
    )) as unknown as Array<{ applied: unknown }>;
    const raw = rows[0]?.applied;
    appliedMillis = raw === null || raw === undefined ? null : Number(raw);
  } catch (error) {
    if (!isMissingRelationError(error)) throw error;
  }
  if (appliedMillis !== null) {
    return appliedMillis >= LATEST_MIGRATION_MILLIS
      ? { state: 'ready', appliedMillis }
      : { state: 'pending', appliedMillis };
  }
  // No applied migration on record (no bookkeeping, or an empty table). A
  // brand-new database looks exactly like this until its first migration
  // lands, so only an already-populated schema counts as managed some other
  // way (drizzle push in dev and tests); an empty one is a migration that
  // has not started yet. The migrator applies each migration and its
  // bookkeeping row in one transaction, so a populated schema with an empty
  // table is never a migration in flight.
  const tables = (await database.execute(
    sql`select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  )) as unknown as Array<{ count: unknown }>;
  return Number(tables[0]?.count ?? 0) > 0
    ? { state: 'unmanaged' }
    : { state: 'pending', appliedMillis: null };
}

export class MigrationsNotReadyError extends Error {
  constructor(readonly readiness: MigrationReadiness) {
    super(
      `Database migrations did not reach ${LATEST_MIGRATION_TAG ?? LATEST_MIGRATION_MILLIS} in time (applied: ${
        readiness.state === 'pending'
          ? (readiness.appliedMillis ?? 'none')
          : readiness.state
      }).`,
    );
    this.name = 'MigrationsNotReadyError';
  }
}

/**
 * Blocks until the database has every migration this build ships with.
 *
 * Deployments roll all services at once while migrations run only ahead of
 * the api service, so a worker that reads a column the pending migration
 * adds would otherwise crash at boot, exhaust the platform's restart budget
 * within seconds, and stay down after the migration lands. Waiting here
 * turns that into a delayed start. A populated database without drizzle
 * bookkeeping is treated as ready (its schema is managed some other way);
 * an empty one waits for its first migration like any other.
 */
export async function waitForMigrations(options: {
  database: DatabaseOrTransaction;
  timeoutMs?: number;
  intervalMs?: number;
  logEveryMs?: number;
  log?: (message: string) => void;
}): Promise<MigrationReadiness> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const logEveryMs = options.logEveryMs ?? 30_000;
  const log = options.log ?? (() => {});
  const startedAt = Date.now();
  let lastLogAt = 0;

  for (;;) {
    const readiness = await checkMigrationReadiness(options.database);
    if (readiness.state !== 'pending') return readiness;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) throw new MigrationsNotReadyError(readiness);
    if (lastLogAt === 0 || Date.now() - lastLogAt >= logEveryMs) {
      lastLogAt = Date.now();
      log(
        `Waiting for database migrations: applied ${readiness.appliedMillis ?? 'none'}, expected ${LATEST_MIGRATION_TAG ?? LATEST_MIGRATION_MILLIS} (${Math.round(elapsed / 1000)}s elapsed).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

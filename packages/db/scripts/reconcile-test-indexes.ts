/**
 * Re-assert index definitions that `drizzle-kit push` cannot reconcile.
 *
 * push does not detect changes to the WHERE predicate of expression indexes,
 * so a persistent test database keeps whatever predicate an index had when it
 * was first created. Real deployments pick up predicate changes through
 * generated migrations (e.g. drizzle/0067_clean_storm.sql), but the test
 * database is synced exclusively via push, which reports "Changes applied"
 * while silently leaving the stale index in place. This runs after every
 * `db:push:test` to close that gap.
 *
 * Each entry mirrors the definition in src/schema.ts; `mustContain` lists
 * predicate fragments (as Postgres normalizes them in pg_indexes.indexdef)
 * whose absence marks the index as stale.
 */
import { assertSafeTestDatabaseUrl, postgres } from '../src/server';

interface ManagedIndex {
  name: string;
  mustContain: string[];
  createSql: string;
}

const MANAGED_INDEXES: ManagedIndex[] = [
  {
    name: 'task_runs_launch_idempotency_key_unique',
    mustContain: ['canceled_at IS NULL'],
    createSql: `CREATE UNIQUE INDEX "task_runs_launch_idempotency_key_unique" ON "task_runs" USING btree (("payload"->>'launchIdempotencyKey')) WHERE "task_runs"."payload"->>'launchIdempotencyKey' IS NOT NULL AND "task_runs"."canceled_at" IS NULL`,
  },
  {
    name: 'task_runs_discord_source_event_unique',
    mustContain: ['canceled_at IS NULL'],
    createSql: `CREATE UNIQUE INDEX "task_runs_discord_source_event_unique" ON "task_runs" USING btree (("payload"->>'communicationSourceEventId')) WHERE "task_runs"."payload"->>'communicationProvider' = 'discord' AND "task_runs"."payload"->>'communicationSourceEventId' IS NOT NULL AND "task_runs"."canceled_at" IS NULL`,
  },
];

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://postgres:password@localhost:15432/roomote_test';

assertSafeTestDatabaseUrl(databaseUrl, 'test');

const sql = postgres(databaseUrl, {
  prepare: false,
  max: 1,
  onnotice: () => {},
});

try {
  for (const index of MANAGED_INDEXES) {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${index.name}
    `;
    const indexdef = rows[0]?.indexdef;

    if (
      indexdef &&
      index.mustContain.every((fragment) => indexdef.includes(fragment))
    ) {
      continue;
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(`DROP INDEX IF EXISTS "${index.name}"`);
      await tx.unsafe(index.createSql);
    });

    console.log(
      `[reconcile-test-indexes] Recreated ${index.name} (was ${indexdef ? 'stale' : 'missing'}).`,
    );
  }
} finally {
  await sql.end();
}

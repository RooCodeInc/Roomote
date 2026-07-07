import {
  assertSafeTestDatabaseUrl,
  postgres,
  drizzle,
  sql,
} from '@roomote/db/server';

let pgClient: ReturnType<typeof postgres> | undefined = undefined;

async function truncateAllTables() {
  if (!pgClient) {
    const databaseUrl =
      process.env.DATABASE_URL ??
      'postgres://postgres:password@localhost:5432/test';

    assertSafeTestDatabaseUrl(databaseUrl, 'test');

    pgClient = postgres(databaseUrl, {
      prepare: false,
      onnotice: () => {}, // Suppress NOTICE logs.
    });
  }

  const db = drizzle({ client: pgClient });

  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE';
  `);

  const tableNames = tables.map((t) => t.table_name);

  for (const tableName of tableNames) {
    await db.execute(sql`TRUNCATE TABLE "${sql.raw(tableName)}" CASCADE;`);
  }
}

export default async function () {
  await truncateAllTables();

  return async () => {
    // Truncate again on teardown so `db:push:test` (which runs before
    // `turbo test`) never encounters stale rows that block constraint changes.
    await truncateAllTables();
    await pgClient?.end();
  };
}

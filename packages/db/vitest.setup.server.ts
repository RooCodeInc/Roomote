import {
  assertSafeTestDatabaseUrl,
  drizzle,
  postgres,
  sql,
} from './src/server';

let pgClient: ReturnType<typeof postgres> | undefined;

async function truncateAllTables() {
  if (!pgClient) {
    const databaseUrl =
      process.env.DATABASE_URL ??
      'postgres://postgres:password@localhost:15432/roomote_test';

    assertSafeTestDatabaseUrl(databaseUrl, 'test');

    pgClient = postgres(databaseUrl, {
      prepare: false,
      onnotice: () => {},
    });
  }

  const db = drizzle({ client: pgClient });

  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE';
  `);

  const tableNames = tables.map((table) => table.table_name);

  for (const tableName of tableNames) {
    await db.execute(sql`TRUNCATE TABLE "${sql.raw(tableName)}" CASCADE;`);
  }
}

export default async function () {
  await truncateAllTables();

  return async () => {
    await truncateAllTables();
    await pgClient?.end();
  };
}

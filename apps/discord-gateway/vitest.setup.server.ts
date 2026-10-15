import { setupTestDatabaseLifecycle } from '@roomote/db/test-database-lifecycle';

export default async function () {
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgres://postgres:password@localhost:5432/test';

  return setupTestDatabaseLifecycle(databaseUrl);
}

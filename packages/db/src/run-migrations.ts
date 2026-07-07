/**
 * Self-contained migration runner for the Docker runtime images, where pnpm,
 * drizzle-kit, and the workspace are unavailable. Bundled by the api
 * Dockerfile into /roomote/migrate/migrate.mjs next to a copy of the
 * drizzle/ migrations folder. Uses the same journal and
 * drizzle.__drizzle_migrations bookkeeping as `pnpm db:migrate`, so the two
 * runners are interchangeable against the same database.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const migrationsFolder =
  process.env.DRIZZLE_MIGRATIONS_FOLDER ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'drizzle');

const client = postgres(databaseUrl, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log('Database migrations applied.');
} finally {
  await client.end();
}

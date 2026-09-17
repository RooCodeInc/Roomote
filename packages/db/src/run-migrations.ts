/**
 * Self-contained migration runner for the Docker runtime images, where pnpm,
 * drizzle-kit, and the workspace are unavailable. Bundled by the api
 * Dockerfile into /roomote/migrate/migrate.mjs next to a copy of the
 * drizzle/ migrations folder. Uses the same journal and
 * drizzle.__drizzle_migrations bookkeeping as `pnpm db:migrate`, so the two
 * runners are interchangeable against the same database.
 *
 * Connection drops during the run are retried a few times: drizzle applies
 * the batch in a single transaction, so a failed attempt leaves nothing
 * behind. See migration-retry.ts for why uncaught exceptions are handled.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { describeError, retryOnConnectionError } from './migration-retry';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const migrationsFolder =
  process.env.DRIZZLE_MIGRATIONS_FOLDER ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'drizzle');

// postgres.js can surface a dropped connection as an uncaughtException
// (porsager/postgres#1208). Route it to the in-flight attempt so the retry
// loop sees it; outside an attempt, fail loudly instead of with a bare stack.
let rejectCurrentAttempt: ((error: unknown) => void) | null = null;

process.on('uncaughtException', (error) => {
  if (rejectCurrentAttempt) {
    rejectCurrentAttempt(error);
    return;
  }

  console.error(
    `Database migration failed unexpectedly: ${describeError(error)}`,
  );
  console.error(error);
  process.exit(1);
});

async function runMigrationsOnce(): Promise<void> {
  const client = postgres(databaseUrl!, { max: 1 });

  const uncaught = new Promise<never>((_, reject) => {
    rejectCurrentAttempt = reject;
  });

  try {
    await Promise.race([
      migrate(drizzle(client), { migrationsFolder }),
      uncaught,
    ]);
  } finally {
    rejectCurrentAttempt = null;
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

try {
  await retryOnConnectionError(runMigrationsOnce, {
    maxAttempts: MAX_ATTEMPTS,
    delayMs: RETRY_DELAY_MS,
    onRetry: (error, attempt, maxAttempts) => {
      console.warn(
        `Database migration attempt ${attempt}/${maxAttempts} lost its connection (${describeError(error)}); retrying.`,
      );
    },
  });
  console.log('Database migrations applied.');
} catch (error) {
  console.error(`Database migration failed: ${describeError(error)}`);
  console.error(error);
  process.exit(1);
}

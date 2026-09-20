import { createHash } from 'node:crypto';

import postgres from 'postgres';

import { assertSafeTestDatabaseUrl } from '../db';

const lifecycleLockName = 'roomote:test-database-lifecycle';

type ActiveLifecycle = {
  references: number;
  teardown: () => Promise<void>;
};

const activeLifecycles = new Map<string, Promise<ActiveLifecycle>>();

function getProcessMarker(databaseUrl: string) {
  return `ROOMOTE_TEST_DATABASE_LIFECYCLE_${createHash('sha256')
    .update(databaseUrl)
    .digest('hex')
    .slice(0, 16)}`;
}

async function createTestDatabaseLifecycle(databaseUrl: string) {
  assertSafeTestDatabaseUrl(databaseUrl, 'test');

  const pgClient = postgres(databaseUrl, {
    prepare: false,
    onnotice: () => {},
  });
  let connection: Awaited<ReturnType<typeof pgClient.reserve>> | undefined;
  let lockAcquired = false;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;

    const cleanupErrors: unknown[] = [];
    if (lockAcquired && connection) {
      try {
        await connection`
          SELECT pg_advisory_unlock(
            hashtext(${lifecycleLockName}),
            hashtext(current_database())
          )
        `;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      connection?.release();
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      await pgClient.end();
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        'Failed to release the test database lifecycle lock and client',
      );
    }
  };

  const truncateAllTables = async () => {
    if (!connection) throw new Error('Test database connection is not ready');

    const tables = await connection<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `;

    for (const { table_name: tableName } of tables) {
      await connection.unsafe(
        `TRUNCATE TABLE "${tableName.replaceAll('"', '""')}" CASCADE`,
      );
    }
  };

  try {
    connection = await pgClient.reserve();
    await connection`
      SELECT pg_advisory_lock(
        hashtext(${lifecycleLockName}),
        hashtext(current_database())
      )
    `;
    lockAcquired = true;
    await truncateAllTables();
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Test database setup and cleanup both failed',
      );
    }
    throw error;
  }

  return async () => {
    let teardownError: unknown;
    try {
      await truncateAllTables();
    } catch (error) {
      teardownError = error;
    }

    try {
      await close();
    } catch (cleanupError) {
      if (teardownError) {
        throw new AggregateError(
          [teardownError, cleanupError],
          'Test database teardown and cleanup both failed',
        );
      }
      throw cleanupError;
    }

    if (teardownError) throw teardownError;
  };
}

export async function setupTestDatabaseLifecycle(databaseUrl: string) {
  let lifecyclePromise = activeLifecycles.get(databaseUrl);
  if (!lifecyclePromise) {
    const processMarker = getProcessMarker(databaseUrl);
    const processId = String(process.pid);
    if (process.env[processMarker] === processId) return async () => {};
    process.env[processMarker] = processId;

    lifecyclePromise = createTestDatabaseLifecycle(databaseUrl).then(
      (teardown) => ({ references: 0, teardown }),
    );
    activeLifecycles.set(databaseUrl, lifecyclePromise);

    try {
      await lifecyclePromise;
    } catch (error) {
      if (activeLifecycles.get(databaseUrl) === lifecyclePromise) {
        activeLifecycles.delete(databaseUrl);
      }
      if (process.env[processMarker] === processId) {
        delete process.env[processMarker];
      }
      throw error;
    }
  }

  let lifecycle: ActiveLifecycle;
  try {
    lifecycle = await lifecyclePromise;
  } catch (error) {
    if (activeLifecycles.get(databaseUrl) === lifecyclePromise) {
      activeLifecycles.delete(databaseUrl);
    }
    throw error;
  }

  lifecycle.references += 1;
  let released = false;

  return async () => {
    if (released) return;
    released = true;
    lifecycle.references -= 1;
    if (lifecycle.references > 0) return;

    try {
      await lifecycle.teardown();
    } finally {
      if (activeLifecycles.get(databaseUrl) === lifecyclePromise) {
        activeLifecycles.delete(databaseUrl);
      }

      const processMarker = getProcessMarker(databaseUrl);
      if (process.env[processMarker] === String(process.pid)) {
        delete process.env[processMarker];
      }
    }
  };
}

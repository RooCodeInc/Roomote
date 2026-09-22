import postgres from 'postgres';

import { assertSafeTestDatabaseUrl } from '../db';

const lifecycleLockName = 'roomote:test-database-lifecycle';

type ActiveLifecycle = {
  references: number;
  teardown: () => Promise<void>;
};

const lifecycleStateKey = Symbol.for('roomote.test-database-lifecycles');
const lifecycleProcess = process as typeof process & {
  [lifecycleStateKey]?: Map<string, Promise<ActiveLifecycle>>;
};
// Vitest can evaluate setup modules separately in one process. Every module
// must share both the pending setup and its ownership count.
const activeLifecycles = (lifecycleProcess[lifecycleStateKey] ??= new Map());

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
    lifecyclePromise = createTestDatabaseLifecycle(databaseUrl).then(
      (teardown) => ({ references: 0, teardown }),
    );
    activeLifecycles.set(databaseUrl, lifecyclePromise);
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

    // A new setup must not join a lifecycle whose final teardown has begun.
    // Its fresh connection waits for this lifecycle's advisory lock instead.
    if (activeLifecycles.get(databaseUrl) === lifecyclePromise) {
      activeLifecycles.delete(databaseUrl);
    }
    await lifecycle.teardown();
  };
}

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { createRoomoteEnv, getRuntimeBootstrapState } from '@roomote/env';

import * as schema from './schema';

const clients: postgres.Sql[] = [];
let currentDatabaseUrl: string | null = null;
let initializationMode: 'explicit' | 'lazy' | null = null;

type DrizzleQueryErrorLike = Error & {
  query?: unknown;
  params?: unknown;
  cause?: unknown;
};

type DatabaseReachabilityStatus =
  | 'reachable'
  | 'unreachable'
  | 'missing'
  | 'invalid';

function describeDatabaseUrl(url: string | null | undefined) {
  if (!url) {
    return {
      present: false,
      parsed: false,
      details: null,
      parseError: null,
    };
  }

  try {
    const parsedUrl = new URL(url);

    return {
      present: true,
      parsed: true,
      details: {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || null,
        database: parsedUrl.pathname.replace(/^\//, '') || null,
        hasUsername: parsedUrl.username.length > 0,
        hasPassword: parsedUrl.password.length > 0,
        sslmode: parsedUrl.searchParams.get('sslmode'),
        ssl: parsedUrl.searchParams.get('ssl'),
      },
      parseError: null,
    };
  } catch (error) {
    return {
      present: true,
      parsed: false,
      details: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getDatabaseRuntimeDiagnostics(
  processEnv: NodeJS.ProcessEnv = process.env,
) {
  return {
    clientInitialized: currentDatabaseUrl !== null,
    initializationMode,
    urlsMatch:
      currentDatabaseUrl && processEnv.DATABASE_URL
        ? currentDatabaseUrl === processEnv.DATABASE_URL
        : null,
    configuredUrl: describeDatabaseUrl(currentDatabaseUrl),
    processEnvUrl: describeDatabaseUrl(processEnv.DATABASE_URL),
  };
}

function isDrizzleQueryError(error: unknown): error is DrizzleQueryErrorLike {
  return (
    error instanceof Error &&
    'query' in error &&
    'params' in error &&
    error.message.startsWith('Failed query:')
  );
}

function getDatabaseCauseDiagnostics(error: unknown) {
  if (!error || !(error instanceof Error)) {
    return null;
  }

  const errorWithFields = error as Error & {
    code?: string | number;
    errno?: string | number;
    severity?: string;
    address?: string;
    port?: string | number;
    hostname?: string;
    syscall?: string;
  };

  return {
    name: error.name || null,
    message: error.message || null,
    code: errorWithFields.code ?? null,
    errno: errorWithFields.errno ?? null,
    severity: errorWithFields.severity ?? null,
    address: errorWithFields.address ?? null,
    port: errorWithFields.port ?? null,
    hostname: errorWithFields.hostname ?? null,
    syscall: errorWithFields.syscall ?? null,
  };
}

async function probeDatabaseUrlReachability(
  url: string | null | undefined,
): Promise<{
  status: DatabaseReachabilityStatus;
  error: ReturnType<typeof getDatabaseCauseDiagnostics>;
}> {
  const describedUrl = describeDatabaseUrl(url);

  if (!describedUrl.present) {
    return {
      status: 'missing',
      error: null,
    };
  }

  if (!describedUrl.parsed) {
    return {
      status: 'invalid',
      error: describedUrl.parseError
        ? {
            name: 'InvalidDatabaseUrl',
            message: describedUrl.parseError,
            code: 'INVALID_DATABASE_URL',
            errno: null,
            severity: null,
            address: null,
            port: null,
            hostname: null,
            syscall: null,
          }
        : null,
    };
  }

  const sql = postgres(url!, {
    prepare: false,
    max: 1,
    connect_timeout: 2,
    idle_timeout: 1,
    max_lifetime: 1,
    fetch_types: false,
    onnotice: () => undefined,
  });

  try {
    await sql`select 1`;

    return {
      status: 'reachable',
      error: null,
    };
  } catch (error) {
    return {
      status: 'unreachable',
      error: getDatabaseCauseDiagnostics(error),
    };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

export async function getDatabaseReachabilityDiagnostics(
  processEnv: NodeJS.ProcessEnv = process.env,
) {
  const configuredUrl = currentDatabaseUrl;
  const processEnvUrl = processEnv.DATABASE_URL;
  const urlsMatch =
    configuredUrl && processEnvUrl ? configuredUrl === processEnvUrl : null;

  const configured = await probeDatabaseUrlReachability(configuredUrl);
  const processEnvReachability =
    urlsMatch === true
      ? configured
      : await probeDatabaseUrlReachability(processEnvUrl);

  return {
    urlsMatch,
    configuredUrl: configured,
    processEnvUrl: processEnvReachability,
  };
}

export function getDatabaseErrorDiagnostics(
  error: unknown,
  processEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!isDrizzleQueryError(error)) {
    return null;
  }

  return {
    kind: 'drizzle_query_error',
    query: typeof error.query === 'string' ? error.query : null,
    paramCount: Array.isArray(error.params) ? error.params.length : null,
    runtime: getDatabaseRuntimeDiagnostics(processEnv),
    cause: getDatabaseCauseDiagnostics(error.cause),
  };
}

const DEFAULT_POOL_MAX = 10;

/**
 * Pool size for the postgres.js client. Connections go through the Supabase
 * transaction-mode pooler, so these are cheap client connections — the pooler
 * caps actual Postgres backends. The postgres.js default of 10 is too small
 * for the API under load: slow queries queue behind the pool and request
 * latency compounds until process health checks fail. Read from
 * DATABASE_POOL_MAX directly (not the validated env schema) because createDb
 * also runs in contexts where the full env is not bootstrapped (tests, web
 * explicit init).
 */
function resolvePoolMax(processEnv: NodeJS.ProcessEnv = process.env): number {
  const raw = processEnv.DATABASE_POOL_MAX;

  if (!raw) {
    return DEFAULT_POOL_MAX;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[createDb] Ignoring invalid DATABASE_POOL_MAX value "${raw}"; using default of ${DEFAULT_POOL_MAX}.`,
    );
    return DEFAULT_POOL_MAX;
  }

  return parsed;
}

/**
 * In `next dev`, HMR re-evaluates this module on server-side recompiles, so
 * a module-scoped pool would leak: every recompile opens a fresh postgres.js
 * pool and the old one is never ended (eventually "sorry, too many clients
 * already"). Cache the raw client on globalThis in development only —
 * production and tests keep strict per-module lifecycles.
 */
const devClientCache =
  process.env.NODE_ENV === 'development'
    ? (((globalThis as Record<string, unknown>).__roomoteDevPgClients ??=
        new Map<string, postgres.Sql>()) as Map<string, postgres.Sql>)
    : null;

export const createDb = (url: string) => {
  currentDatabaseUrl = url;
  const cachedClient = devClientCache?.get(url);
  const client =
    cachedClient ?? postgres(url, { prepare: false, max: resolvePoolMax() });

  if (!cachedClient) {
    devClientCache?.set(url, client);
    clients.push(client);
  }

  return drizzle({ client, schema });
};

type Database = ReturnType<typeof createDb>;
type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

export function assertSafeTestDatabaseUrl(
  url: string,
  nodeEnv: string | undefined,
) {
  if (nodeEnv !== 'test') {
    return;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`DATABASE_URL is not a valid test database URL: ${url}`);
  }

  const hostname = parsedUrl.hostname;
  const databaseName = parsedUrl.pathname.replace(/^\//, '');
  const isLocalhost =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const isTestDatabase =
    databaseName === 'test' ||
    databaseName.endsWith('_test') ||
    databaseName.endsWith('-test');

  if (!isLocalhost || !isTestDatabase) {
    throw new Error(
      `DATABASE_URL is not a test database (host=${hostname}, database=${databaseName})`,
    );
  }
}

function getNextRuntime(
  processEnv: NodeJS.ProcessEnv = process.env,
): 'nodejs' | 'edge' | undefined {
  return processEnv.NEXT_RUNTIME === 'nodejs' ||
    processEnv.NEXT_RUNTIME === 'edge'
    ? processEnv.NEXT_RUNTIME
    : undefined;
}

function isNextBuildPhase(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return processEnv.NEXT_PHASE === 'phase-production-build';
}

function assertWebRuntimeBootstrapCompleted(
  processEnv: NodeJS.ProcessEnv = process.env,
) {
  if (
    getNextRuntime(processEnv) !== 'nodejs' ||
    getRuntimeBootstrapState().hasExplicitBootstrap ||
    isNextBuildPhase(processEnv)
  ) {
    return;
  }

  throw new Error(
    '@roomote/db was accessed before apps/web finished bootstrapping dotenvx-backed runtime env for the Next.js Node.js runtime. This can leave DATABASE_URL missing or stale during serverless cold starts.',
  );
}

function assertExplicitWebDatabaseInitialization(
  processEnv: NodeJS.ProcessEnv = process.env,
) {
  if (getNextRuntime(processEnv) !== 'nodejs' || isNextBuildPhase(processEnv)) {
    return;
  }

  if (initializationMode === 'explicit' && currentDatabaseUrl) {
    return;
  }

  if (!getRuntimeBootstrapState().hasExplicitBootstrap) {
    assertWebRuntimeBootstrapCompleted(processEnv);
  }

  throw new Error(
    '@roomote/db was accessed before apps/web explicitly initialized the database singleton from the validated runtime env. This can leave serverless instances pinned to a stale or fallback DATABASE_URL.',
  );
}

let dbInstance: Database | null = null;

function createAndStoreDb(url: string, mode: 'explicit' | 'lazy'): Database {
  dbInstance = createDb(url);
  initializationMode = mode;
  return dbInstance;
}

function assertNonEmptyDatabaseUrl(url: unknown): asserts url is string {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error('DATABASE_URL must be a non-empty string.');
  }
}

async function disconnectInternal() {
  dbInstance = null;
  currentDatabaseUrl = null;
  initializationMode = null;

  // After an HMR re-evaluation the module-scoped `clients` array is empty
  // while the dev cache still holds live pools, so ending only `clients`
  // would orphan them — end the union of both.
  const clientsToEnd = new Set<postgres.Sql>(clients);

  if (devClientCache) {
    for (const client of devClientCache.values()) {
      clientsToEnd.add(client);
    }

    devClientCache.clear();
  }

  for (const client of clientsToEnd) {
    await client.end();
  }

  clients.length = 0;
}

export async function initializeDb(url: string): Promise<Database> {
  assertNonEmptyDatabaseUrl(url);

  if (
    dbInstance &&
    currentDatabaseUrl === url &&
    initializationMode === 'explicit'
  ) {
    return dbInstance;
  }

  // Only tear down when this module evaluation actually owns state. A
  // freshly re-evaluated module (next dev HMR) has nothing to disconnect —
  // skipping the teardown lets createDb reuse the dev-cached pool instead
  // of orphaning it.
  if (currentDatabaseUrl !== null || clients.length > 0) {
    await disconnectInternal();
  }

  return createAndStoreDb(url, 'explicit');
}

function getDb(): Database {
  if (dbInstance) {
    return dbInstance;
  }

  if (getNextRuntime(process.env) === 'nodejs') {
    assertExplicitWebDatabaseInitialization(process.env);
  }

  const env = createRoomoteEnv(process.env);

  assertNonEmptyDatabaseUrl(env.DATABASE_URL);
  assertSafeTestDatabaseUrl(env.DATABASE_URL, env.NODE_ENV);

  dbInstance = createAndStoreDb(env.DATABASE_URL, 'lazy');

  return dbInstance;
}

const db = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    const realDb = getDb();
    const value = Reflect.get(realDb, prop, receiver);

    if (typeof value === 'function') {
      return value.bind(realDb);
    }

    return value;
  },
  has(_target, prop) {
    return Reflect.has(getDb(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getDb());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const descriptor = Reflect.getOwnPropertyDescriptor(getDb(), prop);

    if (!descriptor) {
      return descriptor;
    }

    return { ...descriptor, configurable: true };
  },
});

const disconnect = async () => {
  await disconnectInternal();
};

const rehydrateDb = async () => {
  await disconnect();
};

type DatabaseOrTransaction = Database | DatabaseTransaction;

export {
  db,
  disconnect,
  rehydrateDb,
  type DatabaseOrTransaction,
  type DatabaseTransaction,
};

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkMigrationReadiness,
  LATEST_MIGRATION_MILLIS,
  LATEST_MIGRATION_TAG,
  MigrationsNotReadyError,
  waitForMigrations,
} from '../lib/migration-readiness';

const journalPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle/meta/_journal.json',
);

function databaseReturning(applied: unknown, publicTables = 0) {
  return {
    execute: vi.fn(async (query: unknown) =>
      JSON.stringify(query).includes('information_schema')
        ? [{ count: publicTables }]
        : [{ applied }],
    ),
  } as unknown as Parameters<typeof checkMigrationReadiness>[0];
}

function databaseThrowing(code: string, publicTables = 0) {
  return {
    execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
      // The bookkeeping read fails; the fallback table count answers.
      if (JSON.stringify(query).includes('information_schema')) {
        return [{ count: publicTables }];
      }
      throw Object.assign(new Error('relation missing'), { code });
    }),
  } as unknown as Parameters<typeof checkMigrationReadiness>[0];
}

describe('migration readiness', () => {
  it('expects the newest journal entry', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ when: number; tag: string }>;
    };
    const newest = journal.entries.at(-1)!;
    expect(LATEST_MIGRATION_MILLIS).toBe(newest.when);
    expect(LATEST_MIGRATION_TAG).toBe(newest.tag);
  });

  it('reports ready once the applied migration reaches the expected one', async () => {
    await expect(
      checkMigrationReadiness(
        databaseReturning(String(LATEST_MIGRATION_MILLIS)),
      ),
    ).resolves.toEqual({
      state: 'ready',
      appliedMillis: LATEST_MIGRATION_MILLIS,
    });
    await expect(
      checkMigrationReadiness(databaseReturning(LATEST_MIGRATION_MILLIS + 1)),
    ).resolves.toMatchObject({ state: 'ready' });
  });

  it('reports pending behind the expected migration or with no rows on an empty schema', async () => {
    await expect(
      checkMigrationReadiness(databaseReturning(LATEST_MIGRATION_MILLIS - 1)),
    ).resolves.toEqual({
      state: 'pending',
      appliedMillis: LATEST_MIGRATION_MILLIS - 1,
    });
    await expect(
      checkMigrationReadiness(databaseReturning(null, 0)),
    ).resolves.toEqual({ state: 'pending', appliedMillis: null });
  });

  it('treats an empty bookkeeping table over a populated schema as unmanaged', async () => {
    // drizzle-kit push leaves the table behind with no rows in dev and tests.
    await expect(
      checkMigrationReadiness(databaseReturning(null, 92)),
    ).resolves.toEqual({ state: 'unmanaged' });
  });

  it('treats a populated database without drizzle bookkeeping as unmanaged and rethrows other errors', async () => {
    await expect(
      checkMigrationReadiness(databaseThrowing('42P01', 12)),
    ).resolves.toEqual({ state: 'unmanaged' });
    await expect(
      checkMigrationReadiness(databaseThrowing('3F000', 12)),
    ).resolves.toEqual({ state: 'unmanaged' });
    await expect(
      checkMigrationReadiness(databaseThrowing('57P01')),
    ).rejects.toThrow('relation missing');
  });

  it('waits on a brand-new database whose first migration has not run', async () => {
    // Fresh Railway/Render databases have neither the drizzle schema nor
    // any application table until the api pre-deploy migration starts.
    await expect(
      checkMigrationReadiness(databaseThrowing('3F000', 0)),
    ).resolves.toEqual({ state: 'pending', appliedMillis: null });
    await expect(
      waitForMigrations({
        database: databaseThrowing('42P01', 0),
        intervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(MigrationsNotReadyError);
  });

  it('waits until the migration lands, logging while it does', async () => {
    let applied = LATEST_MIGRATION_MILLIS - 10;
    const database = {
      execute: vi.fn(async () => {
        applied += 5;
        return [{ applied }];
      }),
    } as unknown as Parameters<typeof checkMigrationReadiness>[0];
    const log = vi.fn();

    await expect(
      waitForMigrations({ database, intervalMs: 1, logEveryMs: 0, log }),
    ).resolves.toEqual({
      state: 'ready',
      appliedMillis: LATEST_MIGRATION_MILLIS,
    });
    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Waiting for database migrations'),
    );
  });

  it('gives up after the timeout', async () => {
    await expect(
      waitForMigrations({
        database: databaseReturning(null),
        intervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(MigrationsNotReadyError);
  });
});

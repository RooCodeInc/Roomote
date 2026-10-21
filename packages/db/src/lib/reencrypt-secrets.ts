import { is, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

import { getEncryptionKeyPrevious } from '@roomote/env';

import { db as defaultDb, type DatabaseOrTransaction } from '../db';
import * as schema from '../schema';
import { isEncryptedColumn } from './custom-types';
import { decryptWithKeyGeneration, encrypt } from './encryption';

/**
 * Re-encrypts stored secrets with the current `ENCRYPTION_KEY`.
 *
 * After an operator rotates `ENCRYPTION_KEY` (keeping the old value in
 * `ENCRYPTION_KEY_PREVIOUS`), values written before the rotation stay readable
 * through the decrypt fallback but are still encrypted with the old key. This
 * walks every location that stores ciphertext, decrypts each value with
 * whichever key works, and rewrites values that only the previous key opens.
 *
 * - Idempotent: values already on the current key are left untouched, so the
 *   command can be re-run until it reports nothing left on the previous key.
 * - Concurrency-safe: each rewrite is a compare-and-swap on the value that was
 *   read, so a concurrent application write is never overwritten; the row is
 *   reported as a conflict and picked up by the next run.
 * - Plaintext leftovers (values that are not ciphertext at all) are reported
 *   and left alone.
 */

/** Smallest valid ciphertext: salt(32) + iv(16) + tag(16) + empty payload. */
const MIN_CIPHERTEXT_BYTES = 64;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const DEFAULT_BATCH_SIZE = 200;

/** Where ciphertext lives inside a JSON column. `*` matches every key. */
type JsonPath = readonly string[];

export interface EncryptedLocation {
  /** SQL table name. */
  table: string;
  /** SQL column name. */
  column: string;
  /** SQL primary-key column names (composite keys list every column). */
  primaryKey: readonly string[];
  /**
   * `ciphertext`: the whole column value is one ciphertext string (the
   * `encryptedText` / `encryptedJson` column types).
   * `json`: a jsonb column whose string leaves at `paths` are ciphertext.
   */
  shape: { kind: 'ciphertext' } | { kind: 'json'; paths: readonly JsonPath[] };
}

/**
 * Ciphertext written with manual `encrypt()` calls into fields of plain jsonb
 * columns. Columns declared with the encrypted column types are discovered
 * from the schema automatically; anything that stores `encrypt()` output in a
 * regular column must be listed here so key rotation can rewrite it.
 */
export const MANUAL_ENCRYPTED_LOCATIONS: readonly EncryptedLocation[] = [
  {
    // Integration credentials; the field depends on the connection type.
    table: 'mcp_connections',
    column: 'auth_config',
    primaryKey: ['id'],
    shape: {
      kind: 'json',
      paths: [
        ['client_secret'],
        ['encryptedPrivateKey'],
        ['encryptedPrivateKeyPassphrase'],
        ['encryptedToken'],
        ['encryptedApiToken'],
        ['encryptedApiKey'],
        ['encryptedBearerToken'],
        ['encryptedAccessToken'],
        ['encryptedServiceAccountToken'],
        ['encryptedAgentClientSecret'],
        ['encryptedIngestClientSecret'],
        ['encryptedMaintenanceClientSecret'],
      ],
    },
  },
  {
    // Header name -> encrypted header value.
    table: 'custom_mcp_servers',
    column: 'headers',
    primaryKey: ['id'],
    shape: { kind: 'json', paths: [['*']] },
  },
  {
    // stdio launch config; env var name -> encrypted value.
    table: 'custom_mcp_servers',
    column: 'stdio',
    primaryKey: ['id'],
    shape: { kind: 'json', paths: [['env', '*']] },
  },
  {
    table: 'personal_mcp_servers',
    column: 'headers',
    primaryKey: ['id'],
    shape: { kind: 'json', paths: [['*']] },
  },
];

function primaryKeyColumnNames(table: PgTable): string[] {
  const config = getTableConfig(table);
  const composite = config.primaryKeys[0];

  if (composite) {
    return composite.columns.map((column) => column.name);
  }

  return config.columns
    .filter((column) => column.primary)
    .map((column) => column.name);
}

/** Every `encryptedText` / `encryptedJson` column declared in the schema. */
export function discoverEncryptedColumnLocations(): EncryptedLocation[] {
  const locations: EncryptedLocation[] = [];

  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) {
      continue;
    }

    const config = getTableConfig(value);
    const encryptedColumns = config.columns.filter(isEncryptedColumn);

    if (encryptedColumns.length === 0) {
      continue;
    }

    const primaryKey = primaryKeyColumnNames(value);

    if (primaryKey.length === 0) {
      throw new Error(
        `Encrypted table ${config.name} has no primary key; re-encryption needs one to page and update rows safely.`,
      );
    }

    for (const column of encryptedColumns) {
      locations.push({
        table: config.name,
        column: column.name,
        primaryKey,
        shape: { kind: 'ciphertext' },
      });
    }
  }

  return locations.sort((left, right) =>
    `${left.table}.${left.column}`.localeCompare(
      `${right.table}.${right.column}`,
    ),
  );
}

/** Every location that stores ciphertext, schema-discovered plus manual. */
export function listEncryptedLocations(): EncryptedLocation[] {
  return [...discoverEncryptedColumnLocations(), ...MANUAL_ENCRYPTED_LOCATIONS];
}

type ValueStatus = 'current' | 'previous' | 'unreadable' | 'not-encrypted';

function looksLikeCiphertext(value: string): boolean {
  return (
    value.length % 4 === 0 &&
    BASE64_PATTERN.test(value) &&
    Buffer.byteLength(value, 'base64') >= MIN_CIPHERTEXT_BYTES
  );
}

function classify(value: string): {
  status: ValueStatus;
  rewritten?: string;
} {
  if (!looksLikeCiphertext(value)) {
    return { status: 'not-encrypted' };
  }

  try {
    const { plaintext, key } = decryptWithKeyGeneration(value);

    return key === 'current'
      ? { status: 'current' }
      : { status: 'previous', rewritten: encrypt(plaintext) };
  } catch {
    return { status: 'unreadable' };
  }
}

/** Combined status of a row whose column holds several ciphertext values. */
function combineStatuses(statuses: ValueStatus[]): ValueStatus {
  if (statuses.includes('unreadable')) return 'unreadable';
  if (statuses.includes('previous')) return 'previous';
  if (statuses.includes('current')) return 'current';
  return 'not-encrypted';
}

interface JsonEdit {
  /** Concrete key path to a ciphertext leaf. */
  path: string[];
  value: string;
}

function collectJsonEdits(
  node: unknown,
  pattern: JsonPath,
  concretePath: string[],
  statuses: ValueStatus[],
  edits: JsonEdit[],
): void {
  if (pattern.length === 0) {
    if (typeof node !== 'string') {
      return;
    }

    const { status, rewritten } = classify(node);
    statuses.push(status);
    if (rewritten !== undefined) {
      edits.push({ path: concretePath, value: rewritten });
    }
    return;
  }

  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return;
  }

  const [segment, ...rest] = pattern;
  const record = node as Record<string, unknown>;
  const keys =
    segment === '*'
      ? Object.keys(record)
      : Object.hasOwn(record, segment!)
        ? [segment!]
        : [];

  for (const key of keys) {
    collectJsonEdits(
      record[key],
      rest,
      [...concretePath, key],
      statuses,
      edits,
    );
  }
}

function processJsonValue(
  raw: string,
  paths: readonly JsonPath[],
): { status: ValueStatus; edits: JsonEdit[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'not-encrypted', edits: [] };
  }

  const statuses: ValueStatus[] = [];
  const edits: JsonEdit[] = [];
  for (const path of paths) {
    collectJsonEdits(parsed, path, [], statuses, edits);
  }

  return { status: combineStatuses(statuses), edits };
}

/**
 * Applies leaf edits in SQL with nested `jsonb_set` calls so the rest of the
 * document is never round-tripped through JavaScript (which would, for
 * example, lose precision on large numbers).
 */
function jsonbWithEdits(column: SQLWrapper, edits: readonly JsonEdit[]): SQL {
  return edits.reduce<SQL>(
    (expression, edit) =>
      sql`jsonb_set(${expression}, ARRAY[${valueList(edit.path)}]::text[], to_jsonb(${edit.value}::text), false)`,
    sql`${column}`,
  );
}

export interface LocationReport {
  table: string;
  column: string;
  /** Rows with a non-null value that were examined. */
  scanned: number;
  /** Rows already encrypted with the current key. */
  current: number;
  /**
   * Rows with at least one previous-key value rewritten to the current key
   * (dry run: rows that would be). Counted independently of the row's
   * aggregate status, so a jsonb row holding both a previous-key value and a
   * value neither key opens counts as both `migrated` and `unreadable`.
   */
  migrated: number;
  /**
   * Rows with a value that decrypts with neither key. Those values are left
   * untouched; readable previous-key values in the same row are still
   * rewritten.
   */
  unreadable: number;
  /** Rows whose value is not ciphertext (legacy plaintext). Left untouched. */
  notEncrypted: number;
  /** Rows changed concurrently between read and rewrite; re-run to retry. */
  conflicts: number;
  /**
   * Rows that may still hold a previous-key value after this run: every
   * `migrated` row in a dry run, every conflicted row in a live run.
   */
  remainingOnPreviousKey: number;
  /** Set when the table or column does not exist in this database. */
  skipped?: string;
}

export interface ReencryptSecretsReport {
  dryRun: boolean;
  previousKeyConfigured: boolean;
  locations: LocationReport[];
  totals: Omit<LocationReport, 'table' | 'column' | 'skipped'>;
  /**
   * Rows still encrypted with the previous key after this run. Zero means
   * `ENCRYPTION_KEY_PREVIOUS` can be removed (unless rows are unreadable).
   */
  remainingOnPreviousKey: number;
}

export interface ReencryptSecretsOptions {
  dryRun?: boolean;
  batchSize?: number;
  db?: DatabaseOrTransaction;
  locations?: readonly EncryptedLocation[];
  onProgress?: (report: LocationReport) => void;
}

function identifierList(names: readonly string[]): SQL {
  return sql.join(
    names.map((name) => sql.identifier(name)),
    sql.raw(', '),
  );
}

function valueList(values: readonly unknown[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql.raw(', '),
  );
}

async function columnExists(
  database: DatabaseOrTransaction,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await database.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${table}
        AND column_name = ${column}
    ) AS exists
  `);
  return Boolean(rows[0]?.exists);
}

async function reencryptLocation(
  database: DatabaseOrTransaction,
  location: EncryptedLocation,
  dryRun: boolean,
  batchSize: number,
): Promise<LocationReport> {
  const report: LocationReport = {
    table: location.table,
    column: location.column,
    scanned: 0,
    current: 0,
    migrated: 0,
    unreadable: 0,
    notEncrypted: 0,
    conflicts: 0,
    remainingOnPreviousKey: 0,
  };

  if (!(await columnExists(database, location.table, location.column))) {
    report.skipped = 'column not present in this database';
    return report;
  }

  const table = sql.identifier(location.table);
  const column = sql.identifier(location.column);
  const keyColumns = identifierList(location.primaryKey);
  const keyAliases = location.primaryKey.map((_, index) => `pk_${index}`);
  const keySelect = sql.join(
    location.primaryKey.map(
      (name, index) =>
        sql`${sql.identifier(name)}::text AS ${sql.identifier(keyAliases[index]!)}`,
    ),
    sql.raw(', '),
  );

  let lastKey: string[] | null = null;

  for (;;) {
    // Keyset pagination on the primary key keeps each batch a short index
    // scan and makes progress independent of rows rewritten earlier. Key
    // values round-trip as text; Postgres infers the parameter types from
    // the key columns they are compared with.
    const after: SQL = lastKey
      ? sql`AND (${keyColumns}) > (${valueList(lastKey)})`
      : sql``;

    const rows = await database.execute<Record<string, string>>(sql`
      SELECT ${keySelect}, ${column}::text AS value
      FROM ${table}
      WHERE ${column} IS NOT NULL ${after}
      ORDER BY ${keyColumns}
      LIMIT ${batchSize}
    `);

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const raw = row.value!;
      const keyValues = keyAliases.map((alias) => row[alias]!);
      report.scanned += 1;

      let status: ValueStatus;
      let newValue: SQL | undefined;

      if (location.shape.kind === 'json') {
        const result = processJsonValue(raw, location.shape.paths);
        status = result.status;
        newValue =
          result.edits.length > 0
            ? jsonbWithEdits(column, result.edits)
            : undefined;
      } else {
        const result = classify(raw);
        status = result.status;
        newValue =
          result.rewritten === undefined ? undefined : sql`${result.rewritten}`;
      }

      if (status === 'current') report.current += 1;
      if (status === 'not-encrypted') report.notEncrypted += 1;
      if (status === 'unreadable') report.unreadable += 1;

      if (newValue === undefined) {
        continue;
      }

      // A pending rewrite means the row holds at least one value only the
      // previous key opens. Count it even when another value in the same
      // jsonb row is unreadable: the readable values are rewritten (the
      // jsonb_set edits never touch the unreadable leaf), and the operator
      // must not be told the previous key is unused while any remain.
      report.migrated += 1;

      if (dryRun) {
        report.remainingOnPreviousKey += 1;
        continue;
      }

      const updated = await database.execute(sql`
        UPDATE ${table}
        SET ${column} = ${newValue}
        WHERE (${keyColumns}) = (${valueList(keyValues)})
          AND ${column}::text = ${raw}
        RETURNING 1
      `);

      if (updated.length === 0) {
        report.migrated -= 1;
        report.conflicts += 1;
        report.remainingOnPreviousKey += 1;
      }
    }

    lastKey = keyAliases.map((alias) => rows[rows.length - 1]![alias]!);

    if (rows.length < batchSize) {
      break;
    }
  }

  return report;
}

export async function reencryptSecrets(
  options: ReencryptSecretsOptions = {},
): Promise<ReencryptSecretsReport> {
  const database = options.db ?? defaultDb;
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const locations = options.locations ?? listEncryptedLocations();

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
  }

  const reports: LocationReport[] = [];

  for (const location of locations) {
    const report = await reencryptLocation(
      database,
      location,
      dryRun,
      batchSize,
    );
    reports.push(report);
    options.onProgress?.(report);
  }

  const totals = reports.reduce(
    (sum, report) => ({
      scanned: sum.scanned + report.scanned,
      current: sum.current + report.current,
      migrated: sum.migrated + report.migrated,
      unreadable: sum.unreadable + report.unreadable,
      notEncrypted: sum.notEncrypted + report.notEncrypted,
      conflicts: sum.conflicts + report.conflicts,
      remainingOnPreviousKey:
        sum.remainingOnPreviousKey + report.remainingOnPreviousKey,
    }),
    {
      scanned: 0,
      current: 0,
      migrated: 0,
      unreadable: 0,
      notEncrypted: 0,
      conflicts: 0,
      remainingOnPreviousKey: 0,
    },
  );

  return {
    dryRun,
    previousKeyConfigured: Boolean(getEncryptionKeyPrevious()),
    locations: reports,
    totals,
    remainingOnPreviousKey: totals.remainingOnPreviousKey,
  };
}

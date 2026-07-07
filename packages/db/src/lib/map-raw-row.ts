import { getTableColumns, type Table } from 'drizzle-orm';

/**
 * Creates a mapper that converts raw SQL rows (snake_case column names) to
 * Drizzle-shaped objects (camelCase property names) using the table's column
 * definitions as the source of truth.
 *
 * Also coerces timestamp strings returned by `db.execute()` into `Date`
 * objects so the result matches Drizzle's normal query-builder behaviour.
 *
 * Useful when `db.execute(sql\`...\`)` returns raw rows that need to match
 * the inferred select type of a Drizzle table.
 */
export function createRowMapper<T extends Record<string, unknown>>(
  table: Table,
): (row: Record<string, unknown>) => T {
  const columns = getTableColumns(table);

  const dbColToProperty = new Map(
    Object.entries(columns).map(([prop, col]) => [col.name, prop]),
  );

  const timestampCols = new Set(
    Object.values(columns)
      .filter((col) => col.dataType === 'date')
      .map((col) => col.name),
  );

  return (row: Record<string, unknown>): T => {
    const mapped: Record<string, unknown> = {};

    for (const [dbCol, value] of Object.entries(row)) {
      let coerced = value;

      if (timestampCols.has(dbCol) && typeof value === 'string') {
        // PostgreSQL returns timestamp strings without timezone info (e.g.
        // "2026-03-20 06:25:43.813").  Append 'Z' so JS interprets as UTC,
        // matching how the pg driver + Drizzle handle timestamp columns in
        // normal queries.
        const utcStr =
          value.includes('+') || value.includes('Z') ? value : `${value}Z`;

        coerced = new Date(utcStr);
      }

      mapped[dbColToProperty.get(dbCol) ?? dbCol] = coerced;
    }

    return mapped as T;
  };
}

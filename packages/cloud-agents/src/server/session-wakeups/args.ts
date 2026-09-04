/**
 * Models routinely fill every optional tool argument, sending "", null, or a
 * literal "none" for the ones they do not mean to use, and a non-positive
 * number for an unused cap. Dropping those before validation keeps the
 * "exactly one of" rules and ISO date-time checks honest instead of failing
 * on placeholders and burning a retry.
 */
export function normalizeManageWakeupsArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return stripEmpty(args) as Record<string, unknown>;
}

const PLACEHOLDER_STRINGS = new Set(['null', 'none', 'undefined', 'n/a']);
const NON_POSITIVE_NUMERIC_KEYS = new Set([
  'maxRuns',
  'inMinutes',
  'everyMinutes',
]);

function stripEmpty(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripEmpty(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(
        ([nestedKey, nested]) =>
          [nestedKey, stripEmpty(nested, nestedKey)] as const,
      )
      .filter(([, nested]) => nested !== undefined);
    return Object.fromEntries(entries);
  }
  if (value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || PLACEHOLDER_STRINGS.has(trimmed.toLowerCase())) {
      return undefined;
    }
    return value;
  }
  if (
    typeof value === 'number' &&
    key !== undefined &&
    NON_POSITIVE_NUMERIC_KEYS.has(key) &&
    !(value > 0)
  ) {
    return undefined;
  }
  return value;
}

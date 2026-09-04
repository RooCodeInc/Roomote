/**
 * Models routinely fill every optional tool argument, sending "", null, or a
 * literal "none" for the ones they do not mean to use. Dropping those before
 * validation keeps the contract honest instead of failing on placeholders
 * and burning a retry.
 */
export function normalizeManageWakeupsArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return stripEmpty(args) as Record<string, unknown>;
}

const PLACEHOLDER_STRINGS = new Set(['null', 'none', 'undefined', 'n/a']);

function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEmpty);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, stripEmpty(nested)] as const)
      .filter(([, nested]) => nested !== undefined);
    return Object.fromEntries(entries);
  }
  if (value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || PLACEHOLDER_STRINGS.has(trimmed.toLowerCase())) {
      return undefined;
    }
  }
  return value;
}

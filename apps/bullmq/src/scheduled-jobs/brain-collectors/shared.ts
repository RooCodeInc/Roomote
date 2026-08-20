export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function parseDate(value: unknown): Date | null {
  const raw = asString(value);

  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Narrow an unknown to a plain object record, or null. */
export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

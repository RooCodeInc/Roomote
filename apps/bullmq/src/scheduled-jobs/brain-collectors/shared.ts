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

export function formatUtcTime(date: Date): string {
  return date.toISOString().slice(11, 16);
}

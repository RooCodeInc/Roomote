import { SESSION_STATUSES } from '@roomote/types';

export const SESSION_FILTER_KEYS = [
  'user',
  'period',
  'scope',
  'status',
  'q',
  'repository',
  'pullRequest',
  'source',
  'model',
  'archive',
] as const;

type SessionFilterPreferences = Partial<
  Record<(typeof SESSION_FILTER_KEYS)[number], string>
>;

// Store only filter values, never view state, cursors, or arbitrary URL fields.
export function normalizeSessionFilters(
  value: unknown,
): SessionFilterPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const filters: SessionFilterPreferences = {};
  for (const key of SESSION_FILTER_KEYS) {
    const entry = input[key];
    if (typeof entry === 'string' && entry.trim() && entry.length <= 2048) {
      filters[key] = entry;
    }
  }
  if (!['1', '7', '30', '90'].includes(filters.period ?? ''))
    delete filters.period;
  if (!['tasks', 'reviews', 'automations'].includes(filters.scope ?? ''))
    delete filters.scope;
  if (!SESSION_STATUSES.includes(filters.status as never))
    delete filters.status;
  if (!['archived', 'all'].includes(filters.archive ?? ''))
    delete filters.archive;
  if (filters.user === 'all') delete filters.user;
  if (filters.source === 'all') delete filters.source;
  return filters;
}

export function sessionFiltersFromParams(params: URLSearchParams) {
  return normalizeSessionFilters(Object.fromEntries(params));
}

export function ensureExplicitSessionFilters(params: URLSearchParams) {
  if (!SESSION_FILTER_KEYS.some((key) => params.has(key)))
    params.set('scope', 'all');
}

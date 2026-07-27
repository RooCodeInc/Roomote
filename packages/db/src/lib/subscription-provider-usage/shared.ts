import { type DatabaseOrTransaction } from '../../db';

export const USAGE_FETCH_TIMEOUT_MS = 10_000;

export type UsageFetchOptions = {
  executor?: DatabaseOrTransaction;
  fetchImpl?: typeof fetch;
  runtimeEnv?: Partial<Record<string, string | undefined>>;
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const record = asRecord(value);
  return record && 'val' in record ? asFiniteNumber(record.val) : undefined;
}

export function firstNumber(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const parsed = asFiniteNumber(source?.[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

export function firstString(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function toResetIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

export function resetFromRelativeSeconds(
  seconds: number | undefined,
  now: number,
): string | undefined {
  return seconds !== undefined && seconds >= 0
    ? new Date(now + seconds * 1000).toISOString()
    : undefined;
}

export function formatWindowLabel(
  minutes: number | undefined,
): string | undefined {
  if (minutes === undefined || minutes <= 0) {
    return undefined;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 7 ? 'Weekly limit' : `${days}d limit`;
  }
  return minutes % 60 === 0 ? `${minutes / 60}h limit` : `${minutes}m limit`;
}

export async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { status: response.status, payload: undefined };
  }
  try {
    return { status: response.status, payload: await response.json() };
  } catch {
    return { status: response.status, payload: undefined };
  }
}

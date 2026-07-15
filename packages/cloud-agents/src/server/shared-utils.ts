import { Env } from '@roomote/env';

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* / */) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export function normalizeApiBaseUrl(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  return stripTrailingSlashes(trimmed);
}

export function resolveApiBaseUrl(explicit?: string): string | null {
  return (
    normalizeApiBaseUrl(explicit) ??
    normalizeApiBaseUrl(Env.TRPC_URL) ??
    normalizeApiBaseUrl(Env.R_APP_URL)
  );
}

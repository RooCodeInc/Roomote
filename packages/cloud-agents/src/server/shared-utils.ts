import { Env } from '@roomote/env';

export function normalizeApiBaseUrl(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, '');
}

export function resolveApiBaseUrl(explicit?: string): string | null {
  return (
    normalizeApiBaseUrl(explicit) ??
    normalizeApiBaseUrl(Env.TRPC_URL) ??
    normalizeApiBaseUrl(Env.ROOMOTE_APP_URL)
  );
}

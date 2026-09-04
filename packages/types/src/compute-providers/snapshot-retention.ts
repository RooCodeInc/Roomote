import type { ComputeProvider } from './compute-provider';

export const SNAPSHOT_HARD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Legacy providers can still appear on persisted task runs. */
export type SnapshotRetentionProvider = ComputeProvider | 'vercel';

// Both Roomote backends use the same Modal workspace and filesystem images.
export const SNAPSHOT_PROVIDERS_WITHOUT_APPLICATION_EXPIRY = [
  'modal',
  'roomote',
] as const satisfies readonly SnapshotRetentionProvider[];

export function getSnapshotExpiryMs(
  provider: string | null | undefined,
): number | null {
  return SNAPSHOT_PROVIDERS_WITHOUT_APPLICATION_EXPIRY.includes(
    provider as (typeof SNAPSHOT_PROVIDERS_WITHOUT_APPLICATION_EXPIRY)[number],
  )
    ? null
    : SNAPSHOT_HARD_EXPIRY_MS;
}

export function getSnapshotExpiresAt(
  snapshotCreatedAt: Date,
  provider: string | null | undefined,
): Date | null {
  const expiryMs = getSnapshotExpiryMs(provider);
  return expiryMs === null
    ? null
    : new Date(snapshotCreatedAt.getTime() + expiryMs);
}

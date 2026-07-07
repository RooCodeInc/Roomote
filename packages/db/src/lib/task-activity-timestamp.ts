export function normalizeTaskActivityTimestamp(ts: number): number {
  if (!Number.isFinite(ts)) {
    return Math.floor(Date.now() / 1000);
  }

  if (ts >= 1_000_000_000_000) {
    return Math.floor(ts / 1000);
  }

  return Math.floor(ts);
}

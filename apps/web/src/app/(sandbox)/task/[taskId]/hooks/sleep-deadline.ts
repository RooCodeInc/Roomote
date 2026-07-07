export function parseSleepDeadlineMs(
  sleepAt: Date | string | null | undefined,
): number | null {
  if (!sleepAt) {
    return null;
  }

  const timestamp =
    sleepAt instanceof Date ? sleepAt.getTime() : new Date(sleepAt).getTime();

  return Number.isFinite(timestamp) ? timestamp : null;
}

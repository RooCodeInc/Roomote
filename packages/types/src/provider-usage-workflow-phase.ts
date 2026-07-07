export function normalizeProviderUsageWorkflowPhase(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function clampTokenCount(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value === null || value === undefined) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

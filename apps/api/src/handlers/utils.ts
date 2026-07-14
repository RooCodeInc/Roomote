/**
 * Log a handler error with a consistent format.
 */
export function logHandlerError(handlerName: string, error: unknown): void {
  console.error(
    `[${handlerName}] Error:`,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Extract the source-control instance host from a webhook-provided URL (for
 * example a PR/MR web URL). `repositories.host` is derived from the same
 * instance base URL, so this host scopes repository lookups and fact writes
 * to the webhook's own instance instead of every same-name repository across
 * self-managed hosts. Returns null for relative or unparseable URLs, in
 * which case callers fall back to unscoped (provider, full name) matching.
 */
export function toHostFromUrl(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Pick the repository row matching the webhook's instance host, tiering like
 * resolveRepositoryRow: rows whose `host` equals the webhook host win, then
 * legacy rows with a NULL host (written before the host backfill). Without a
 * webhook host the first row is kept (pre-host behavior). Multiple rows in
 * the chosen tier are exotic — these lookups are external-id-first — so the
 * first is taken; the launched task's own host-scoped resolveRepositoryRow
 * is the loud backstop.
 */
export function pickHostScopedRepository<T extends { host: string | null }>(
  rows: T[],
  webhookHost: string | null,
): T | undefined {
  if (!webhookHost) {
    return rows[0];
  }

  return (
    rows.find((row) => row.host === webhookHost) ??
    rows.find((row) => row.host === null)
  );
}

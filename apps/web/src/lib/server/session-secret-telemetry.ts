export function isSessionSecretRoute(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return /\/api\/sessions\/[^/]+\/secrets(?:\/|$)/i.test(
      decodeURIComponent(value.split(/[?#]/)[0]!),
    );
  } catch {
    return /\/api\/sessions\/.*\/secrets/i.test(value);
  }
}

// Drop the whole event: bodies can also be copied into breadcrumbs or contexts.
export function filterSessionSecretTelemetry<
  T extends {
    request?: { url?: string };
    transaction?: string;
  },
>(event: T): T | null {
  return isSessionSecretRoute(event.request?.url) ||
    isSessionSecretRoute(event.transaction)
    ? null
    : event;
}

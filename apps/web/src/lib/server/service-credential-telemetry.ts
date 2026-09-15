export function isServiceCredentialRoute(value: string | undefined): boolean {
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
export function filterServiceCredentialTelemetry<
  T extends {
    request?: { url?: string };
    transaction?: string;
  },
>(event: T): T | null {
  return isServiceCredentialRoute(event.request?.url) ||
    isServiceCredentialRoute(event.transaction)
    ? null
    : event;
}

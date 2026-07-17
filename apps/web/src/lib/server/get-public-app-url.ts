/**
 * Origin used for browser-reachable OAuth callbacks and post-auth redirects.
 * Prefer R_PUBLIC_URL when set so self-hosted fleets with a loopback R_APP_URL
 * and a public edge still advertise a callback the provider can return to.
 */
export function getPublicAppUrl(env: {
  R_APP_URL: string;
  R_PUBLIC_URL?: string | undefined;
}): string {
  return env.R_PUBLIC_URL ?? env.R_APP_URL;
}

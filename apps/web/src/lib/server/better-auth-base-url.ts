import type { BetterAuthOptions } from 'better-auth';

import { getAllowedDevOrigins, resolveAppEnv } from './env';

const LOOPBACK_HOST_PATTERNS = ['localhost', '127.0.0.1'] as const;

function addPortWildcardPattern(pattern: string): string[] {
  if (pattern.includes(':')) {
    return [pattern];
  }

  return [pattern, `${pattern}:*`];
}

function normalizeAllowedHostPatterns(
  roomoteAppUrl: string,
  previewDomainsRaw: string | undefined,
): string[] {
  const canonicalHost = new URL(roomoteAppUrl).host;
  const previewPatterns = getAllowedDevOrigins(previewDomainsRaw);

  return [
    canonicalHost,
    ...previewPatterns.flatMap((pattern) =>
      LOOPBACK_HOST_PATTERNS.includes(
        pattern as (typeof LOOPBACK_HOST_PATTERNS)[number],
      )
        ? addPortWildcardPattern(pattern)
        : [pattern],
    ),
  ];
}

export function getBetterAuthBaseUrlConfig({
  previewDomainsRaw,
  roomoteAppUrl,
}: {
  previewDomainsRaw?: string | undefined;
  roomoteAppUrl: string;
}): BetterAuthOptions['baseURL'] {
  if (resolveAppEnv() === 'production') {
    return roomoteAppUrl;
  }

  return {
    allowedHosts: [
      ...new Set(
        normalizeAllowedHostPatterns(roomoteAppUrl, previewDomainsRaw),
      ),
    ],
    fallback: roomoteAppUrl,
    protocol: 'auto',
  };
}

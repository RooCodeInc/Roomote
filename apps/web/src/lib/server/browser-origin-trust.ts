import { getBetterAuthBaseUrlConfig } from './better-auth-base-url';

export interface BrowserOriginAssessment {
  /** The origin this deployment treats as canonical (from ROOMOTE_APP_URL). */
  canonicalOrigin: string;
  /**
   * Whether the auth layer would accept requests from the given browser
   * origin. When false, sign-in/sign-up/OAuth fail with 403 Invalid origin.
   */
  trusted: boolean;
}

function matchesHostPattern(host: string, pattern: string): boolean {
  if (pattern.endsWith(':*')) {
    const bareHost = host.includes(':')
      ? host.slice(0, host.indexOf(':'))
      : host;
    return matchesHostPattern(bareHost, pattern.slice(0, -2));
  }

  if (pattern.startsWith('*.')) {
    return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  }

  return host === pattern;
}

/**
 * Mirror of the better-auth origin acceptance derived from
 * {@link getBetterAuthBaseUrlConfig}: a strict single-origin comparison in
 * production, host-pattern matching (canonical host, loopback with port
 * wildcards, preview domains) otherwise. Kept in lockstep so the setup and
 * login pages can warn about a mismatch before auth requests 403.
 */
export function assessBrowserOrigin({
  browserOrigin,
  previewDomainsRaw,
  roomoteAppUrl,
}: {
  browserOrigin: string;
  previewDomainsRaw?: string | undefined;
  roomoteAppUrl: string;
}): BrowserOriginAssessment {
  const canonicalOrigin = new URL(roomoteAppUrl).origin;

  let parsedBrowserOrigin: URL;
  try {
    parsedBrowserOrigin = new URL(browserOrigin);
  } catch {
    return { canonicalOrigin, trusted: false };
  }

  const config = getBetterAuthBaseUrlConfig({
    previewDomainsRaw,
    roomoteAppUrl,
  });

  if (typeof config === 'string') {
    return {
      canonicalOrigin,
      trusted: parsedBrowserOrigin.origin === new URL(config).origin,
    };
  }

  const allowedHosts = config?.allowedHosts ?? [];
  return {
    canonicalOrigin,
    trusted: allowedHosts.some((pattern) =>
      matchesHostPattern(parsedBrowserOrigin.host, pattern),
    ),
  };
}

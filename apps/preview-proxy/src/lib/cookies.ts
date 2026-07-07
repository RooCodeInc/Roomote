import { getCachedPreviewRuntimeConfig } from '../services/runtime-config';

/**
 * Extracts the base domain from the PREVIEW_PROXY_BASE_URL for setting cookies.
 * The cookie is set on the base domain so it works across all preview subdomains.
 *
 * Examples:
 * - https://preview.roomote.example -> preview.roomote.example
 * - http://roomotepreview.localhost:8081 -> roomotepreview.localhost
 *
 * Returns an empty string on failure (cookie will be scoped to exact hostname).
 */
export async function getBaseDomain(): Promise<string> {
  try {
    const resolvedPreviewRuntimeConfig = await getCachedPreviewRuntimeConfig();
    const baseUrl = resolvedPreviewRuntimeConfig.effective.previewProxyBaseUrl;

    if (!baseUrl) {
      return '';
    }

    const url = new URL(baseUrl);
    // Return hostname without port
    return url.hostname;
  } catch {
    // Fallback: don't set domain (cookie only valid for exact subdomain)
    return '';
  }
}

/**
 * Returns the cookie Domain attribute value if applicable.
 * Skips domain for localhost (browsers don't support cross-subdomain
 * cookies on localhost).
 */
export async function getCookieDomain(): Promise<string | undefined> {
  const baseDomain = await getBaseDomain();
  if (baseDomain && !baseDomain.includes('localhost')) {
    return `.${baseDomain}`;
  }
  return undefined;
}

interface SetCookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  maxAge?: number;
  path?: string;
  domain?: string;
  partitioned?: boolean;
}

/**
 * Build a Set-Cookie header value.
 */
export function buildSetCookieHeader(
  name: string,
  value: string,
  options: SetCookieOptions,
): string {
  const parts = [`${name}=${value}`];

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.partitioned) {
    parts.push('Partitioned');
  }

  return parts.join('; ');
}

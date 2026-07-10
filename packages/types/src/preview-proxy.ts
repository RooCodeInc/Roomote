/**
 * Default fallback for preview proxy base URL.
 * Used for local development when the environment variable is not set.
 */
export const DEFAULT_PREVIEW_PROXY_BASE_URL =
  'http://roomotepreview.localhost:18081';

const NON_USER_FACING_PORT_NAMES = new Set(['SANDBOX_SERVER', 'EDITOR', 'GUI']);

/**
 * Default header name for preview auth bypass.
 * Used when no environment-specific override is configured.
 */
export const DEFAULT_AUTH_BYPASS_HEADER_NAME = 'x-bypass-roomote-auth';

/**
 * Environment variable for the preview proxy base URL.
 * Contains full protocol, host, and optional port (e.g., 'https://preview.example.com' or 'http://roomotepreview.localhost:18081').
 */
export const PREVIEW_PROXY_BASE_URL_ENV_VAR = 'PREVIEW_PROXY_BASE_URL';

/**
 * Environment variable for the preview domain allowlist.
 * Supports comma-separated list, used for redirect_uri validation.
 */
export const PREVIEW_DOMAIN_ENV_VAR = 'PREVIEW_DOMAINS';

/**
 * Cookie that disables preview widget injection for a request.
 * Intended for browser automation clients where the widget would
 * interfere with internal automation flows such as screenshots and element picking.
 */
export const HIDE_PREVIEW_WIDGET_COOKIE = 'roomote_hide_preview_widget';

/**
 * Gets and validates the preview proxy base URL from environment variable.
 *
 * @param baseUrlRaw - The raw base URL (e.g., 'https://preview.example.com' or 'http://roomotepreview.localhost:18081')
 * @returns The validated base URL
 * @throws Error if baseUrlRaw is not provided or is not a valid URL
 */
export function getPreviewProxyBaseUrl(baseUrlRaw: string | undefined): string {
  if (!baseUrlRaw) {
    throw new Error(
      'PREVIEW_PROXY_BASE_URL environment variable is required but not configured',
    );
  }

  // Validate it's a proper URL by parsing it
  try {
    new URL(baseUrlRaw);
  } catch {
    throw new Error(`PREVIEW_PROXY_BASE_URL is not a valid URL: ${baseUrlRaw}`);
  }

  return baseUrlRaw;
}

/**
 * Constructs a preview proxy URL for a given task and port.
 * Parses the base URL and prepends the subdomain while preserving protocol and port.
 *
 * @param taskId - The task run's taskId (13-char base36)
 * @param portName - The port name (e.g., 'web', 'api')
 * @param baseUrl - The base URL (e.g., 'https://preview.example.com' or 'http://roomotepreview.localhost:18081')
 * @returns The full preview proxy URL
 *
 * @example
 * // Public proxy domain
 * buildPreviewProxyUrl(
 *   '20imtw24sm6hv',
 *   'web',
 *   'https://preview.example.com'
 * )
 * // Returns: 'https://20imtw24sm6hv-web.preview.example.com'
 *
 * @example
 * // Development with port
 * buildPreviewProxyUrl(
 *   '20imtw24sm6hv',
 *   'web',
 *   'http://roomotepreview.localhost:18081'
 * )
 * // Returns: 'http://20imtw24sm6hv-web.roomotepreview.localhost:18081'
 */
export function buildPreviewProxyUrl(
  taskId: string,
  portName: string,
  baseUrl: string,
  subdomainSuffix?: string,
): string {
  const normalizedPortName = portName.toLowerCase();
  const subdomain = subdomainSuffix
    ? `${taskId}-${normalizedPortName}-${subdomainSuffix}`
    : `${taskId}-${normalizedPortName}`;

  // Parse the base URL and prepend subdomain to hostname.
  const url = new URL(baseUrl);
  url.hostname = `${subdomain}.${url.hostname}`;

  // Return without trailing slash.
  return url.toString().replace(/\/$/, '');
}

/**
 * Extracts the first preview domain from a comma-separated list.
 * Strips any port numbers from the domain.
 * Used for redirect_uri validation in auth flows.
 *
 * @param previewDomainsRaw - Comma-separated list of preview domains
 * @returns First domain without port
 * @throws Error if previewDomainsRaw is not provided (mandatory)
 */
export function getPreviewDomain(
  previewDomainsRaw: string | undefined,
): string {
  if (!previewDomainsRaw) {
    throw new Error(
      'PREVIEW_DOMAINS environment variable is required but not configured',
    );
  }

  const domains = previewDomainsRaw
    .split(',')
    .map((d) => d.trim().split(':')[0])
    .filter(Boolean);
  const domain = domains[0];

  if (!domain) {
    throw new Error('PREVIEW_DOMAINS environment variable is empty or invalid');
  }

  return domain;
}

export function getFirstNonInternalPortName(
  portNames: string[],
): string | null {
  return (
    portNames.find((name) => !NON_USER_FACING_PORT_NAMES.has(name)) ?? null
  );
}

export function getPrimaryPortName(
  machineDomain: string | null | undefined,
  machineDomains: Record<string, string> | null | undefined,
  primaryPortName?: string | null,
): string | null {
  if (
    primaryPortName &&
    machineDomains &&
    primaryPortName in machineDomains &&
    !NON_USER_FACING_PORT_NAMES.has(primaryPortName.toUpperCase())
  ) {
    return primaryPortName;
  }

  if (!machineDomains || typeof machineDomains !== 'object') {
    return null;
  }

  if (machineDomain) {
    const matchedPortName = Object.entries(machineDomains).find(
      ([, domain]) => domain === machineDomain,
    )?.[0];

    if (
      matchedPortName &&
      !NON_USER_FACING_PORT_NAMES.has(matchedPortName.toUpperCase())
    ) {
      return matchedPortName;
    }
  }

  return getFirstNonInternalPortName(Object.keys(machineDomains));
}

export function appendInitialPath(
  previewUrl: string,
  initialPath: string | undefined | null,
): string {
  if (!initialPath) {
    return previewUrl;
  }

  const url = new URL(previewUrl);
  const pathUrl = new URL(initialPath, 'http://dummy');

  url.pathname = pathUrl.pathname;
  url.search = pathUrl.search;
  url.hash = pathUrl.hash;

  return url.toString();
}

export function getPrimaryInitialPath(
  machineDomain: string | null | undefined,
  machineDomains: Record<string, string> | null | undefined,
  initialPaths: Record<string, string> | null | undefined,
  primaryPortName?: string | null,
): string | undefined {
  if (!machineDomains || !initialPaths) {
    return undefined;
  }

  const portName = getPrimaryPortName(
    machineDomain,
    machineDomains,
    primaryPortName,
  );

  return portName ? initialPaths[portName] : undefined;
}

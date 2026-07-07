import {
  appendInitialPath,
  buildPreviewProxyUrl,
  DEFAULT_PREVIEW_PROXY_BASE_URL,
  getPrimaryInitialPath,
  getPrimaryPortName,
  portNameToSlug,
} from '@roomote/types';

/**
 * Gets the preview-proxy base URL from environment variable.
 * Falls back to the local preview proxy URL if not set.
 */
export function getPreviewProxyBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL ||
    DEFAULT_PREVIEW_PROXY_BASE_URL
  );
}

function resolvePreviewProxyBaseUrl(
  previewProxyBaseUrl?: string | null,
): string {
  return previewProxyBaseUrl || getPreviewProxyBaseUrl();
}

/**
 * Gets the subdomain suffix for nested preview-proxy support.
 * When set, URLs are constructed with the outer suffix appended so they
 * route through the outer preview-proxy.
 */
function getSubdomainSuffix(): string | undefined {
  return process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX || undefined;
}

export function buildTaskPreviewUrls(
  taskId: string,
  machineDomains: Record<string, string> | undefined | null,
  previewProxyBaseUrl?: string | null,
): Record<string, string> | null {
  if (!machineDomains) {
    return null;
  }

  const baseUrl = resolvePreviewProxyBaseUrl(previewProxyBaseUrl);
  const suffix = getSubdomainSuffix();
  const result: Record<string, string> = {};

  for (const portName of Object.keys(machineDomains)) {
    result[portName] = buildPreviewProxyUrl(
      taskId,
      portNameToSlug(portName),
      baseUrl,
      suffix,
    );
  }

  return result;
}

function getPrimaryPreviewUrl(
  previewUrls: Record<string, string> | null,
  machineDomain: string | null | undefined,
  machineDomains: Record<string, string> | null | undefined,
  primaryPortName?: string | null,
): string | null {
  if (!previewUrls || !machineDomains) {
    return null;
  }

  const portName = getPrimaryPortName(
    machineDomain,
    machineDomains,
    primaryPortName,
  );

  return portName ? (previewUrls[portName] ?? null) : null;
}

export function getPrimaryPreviewUrlWithPath(
  previewUrls: Record<string, string> | null,
  machineDomain: string | null | undefined,
  machineDomains: Record<string, string> | null | undefined,
  initialPaths: Record<string, string> | null | undefined,
  primaryPortName?: string | null,
): string | null {
  const baseUrl = getPrimaryPreviewUrl(
    previewUrls,
    machineDomain,
    machineDomains,
    primaryPortName,
  );

  if (!baseUrl) {
    return null;
  }

  return appendInitialPath(
    baseUrl,
    getPrimaryInitialPath(
      machineDomain,
      machineDomains,
      initialPaths,
      primaryPortName,
    ),
  );
}

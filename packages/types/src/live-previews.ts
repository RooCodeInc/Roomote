import type { EnvironmentConfig, NamedPort } from './environment-config';
import {
  PREVIEW_DOMAIN_ENV_VAR,
  PREVIEW_PROXY_BASE_URL_ENV_VAR,
} from './preview-proxy';

export type PreviewRuntimeIssueCode =
  | 'missing_base_url'
  | 'missing_domains'
  | 'invalid_base_url'
  | 'invalid_domains'
  | 'base_url_domain_mismatch'
  | 'preview_domain_mismatch';

export interface PreviewRuntimeIssue {
  code: PreviewRuntimeIssueCode;
  message: string;
}

export interface PreviewRuntimeConfigInput {
  previewProxyBaseUrl?: string | null;
  previewDomains?: string | null;
  roomotePreviewDomain?: string | null;
}

export interface PreviewRuntimeConfigAnalysis {
  isReady: boolean;
  status: 'ready' | 'missing_runtime_config' | 'validation_failed';
  issues: PreviewRuntimeIssue[];
  previewProxyBaseUrl: string | null;
  previewProxyHostname: string | null;
  previewDomains: string[];
  roomotePreviewDomain: string | null;
  primaryPreviewDomain: string | null;
}

export interface PreviewRuntimeConfigFields {
  previewProxyBaseUrl: string | null;
  previewDomains: string | null;
  roomotePreviewDomain: string | null;
}

function normalizeHostname(value: string | null | undefined): string | null {
  const rawValue = value?.trim();

  if (!rawValue) {
    return null;
  }

  try {
    return new URL(
      rawValue.includes('://') ? rawValue : `https://${rawValue}`,
    ).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parsePreviewProxyBaseUrlHostname(
  value: string | null | undefined,
): string | null {
  const rawValue = value?.trim();

  if (!rawValue) {
    return null;
  }

  try {
    const parsed = new URL(rawValue);
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function deriveRoomotePreviewDomain(
  previewProxyBaseUrl: string | null | undefined,
): string | null {
  return parsePreviewProxyBaseUrlHostname(previewProxyBaseUrl);
}

function parsePreviewDomainEntry(entry: string): string | null {
  const rawEntry = entry.trim();

  if (
    !rawEntry ||
    rawEntry.includes('://') ||
    rawEntry.includes('/') ||
    rawEntry.includes('?') ||
    rawEntry.includes('#')
  ) {
    return null;
  }

  const hostAndPort = rawEntry.split(':');

  if (hostAndPort.length > 2) {
    return null;
  }

  const [hostname, port] = hostAndPort;

  if (!hostname || (port !== undefined && !/^\d+$/.test(port))) {
    return null;
  }

  try {
    const parsed = new URL(`http://${rawEntry}`);
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function parsePreviewDomains(value: string | null | undefined): {
  domains: string[];
  invalidEntries: string[];
} {
  const rawEntries = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!rawEntries?.length) {
    return { domains: [], invalidEntries: [] };
  }

  const domains: string[] = [];
  const invalidEntries: string[] = [];

  for (const entry of rawEntries) {
    const hostname = parsePreviewDomainEntry(entry);

    if (!hostname) {
      invalidEntries.push(entry);
      continue;
    }

    domains.push(hostname);
  }

  return {
    domains: [...new Set(domains)],
    invalidEntries,
  };
}

export function analyzePreviewRuntimeConfig(
  input: PreviewRuntimeConfigInput,
): PreviewRuntimeConfigAnalysis {
  const issues: PreviewRuntimeIssue[] = [];
  const baseUrlRaw = input.previewProxyBaseUrl?.trim() || null;
  const previewProxyHostname = parsePreviewProxyBaseUrlHostname(baseUrlRaw);
  const { domains: previewDomains, invalidEntries } = parsePreviewDomains(
    input.previewDomains,
  );
  const roomotePreviewDomain = normalizeHostname(input.roomotePreviewDomain);

  if (!baseUrlRaw) {
    issues.push({
      code: 'missing_base_url',
      message: `${PREVIEW_PROXY_BASE_URL_ENV_VAR} is not configured.`,
    });
  } else if (!previewProxyHostname) {
    issues.push({
      code: 'invalid_base_url',
      message: `The supplied preview origin is not a valid URL.`,
    });
  }

  if (!input.previewDomains?.trim()) {
    issues.push({
      code: 'missing_domains',
      message: `${PREVIEW_DOMAIN_ENV_VAR} is not configured.`,
    });
  } else if (previewDomains.length === 0 || invalidEntries.length > 0) {
    issues.push({
      code: 'invalid_domains',
      message:
        invalidEntries.length > 0
          ? `${PREVIEW_DOMAIN_ENV_VAR} contains invalid host entries: ${invalidEntries.join(', ')}.`
          : `${PREVIEW_DOMAIN_ENV_VAR} does not contain a valid hostname.`,
    });
  }

  if (
    previewProxyHostname &&
    previewDomains.length > 0 &&
    !previewDomains.includes(previewProxyHostname)
  ) {
    issues.push({
      code: 'base_url_domain_mismatch',
      message: `${PREVIEW_PROXY_BASE_URL_ENV_VAR} hostname must be included in ${PREVIEW_DOMAIN_ENV_VAR}.`,
    });
  }

  if (
    roomotePreviewDomain &&
    previewProxyHostname &&
    roomotePreviewDomain !== previewProxyHostname
  ) {
    issues.push({
      code: 'preview_domain_mismatch',
      message:
        'ROOMOTE_PREVIEW_DOMAIN must match the preview proxy base hostname when it is configured.',
    });
  }

  const status =
    issues.length === 0
      ? 'ready'
      : issues.some(
            (issue) =>
              issue.code === 'missing_base_url' ||
              issue.code === 'missing_domains',
          )
        ? 'missing_runtime_config'
        : 'validation_failed';

  return {
    isReady: status === 'ready',
    status,
    issues,
    previewProxyBaseUrl: baseUrlRaw,
    previewProxyHostname,
    previewDomains,
    roomotePreviewDomain,
    primaryPreviewDomain:
      roomotePreviewDomain ?? previewProxyHostname ?? previewDomains[0] ?? null,
  };
}

export function hasConfiguredPreviewPorts(
  config: Pick<EnvironmentConfig, 'ports'> | undefined,
): boolean {
  return Boolean(config?.ports?.length);
}

export function isEnvironmentPreviewEnabledInConfig(
  config: Pick<EnvironmentConfig, 'previews_enabled'> | undefined,
): boolean {
  return config?.previews_enabled !== false;
}

export function hasAdvancedPreviewConfig(port: NamedPort): boolean {
  return Boolean(
    port.unauthenticated ||
    port.proxied === false ||
    port.subdomain ||
    port.wildcard_prefix ||
    (port.auth_bypass_paths && port.auth_bypass_paths.length > 0),
  );
}

export function buildExamplePreviewHostname(domain: string): string {
  return `abc123def4567-web.${domain}`;
}

export function isLocalPreviewDomain(hostname: string | null | undefined) {
  return Boolean(
    hostname &&
    (hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.localhost')),
  );
}

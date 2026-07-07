import { decrypt } from '@roomote/db/encryption';
import {
  normalizeGrafanaBaseUrl,
  type McpConnectionGrafanaConfig,
} from '@roomote/types';

class GrafanaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrafanaConfigError';
  }
}

export function resolveGrafanaBaseUrl(
  config: McpConnectionGrafanaConfig,
): string {
  try {
    return normalizeGrafanaBaseUrl(config.baseUrl);
  } catch {
    throw new GrafanaConfigError(
      'Grafana connection is missing a valid instance URL',
    );
  }
}

export function resolveGrafanaServiceAccountToken(
  config: McpConnectionGrafanaConfig,
): string {
  const token = decrypt(config.encryptedServiceAccountToken).trim();

  if (!token) {
    throw new GrafanaConfigError(
      'Grafana connection is missing a stored service account token',
    );
  }

  return token;
}

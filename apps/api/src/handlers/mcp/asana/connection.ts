import { decrypt } from '@roomote/db/encryption';
import type { McpConnectionAsanaConfig } from '@roomote/types';

class AsanaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsanaConfigError';
  }
}

export function resolveAsanaAccessToken(
  config: McpConnectionAsanaConfig,
): string {
  const token = decrypt(config.encryptedToken).trim();

  if (!token) {
    throw new AsanaConfigError('Asana connection is missing a stored token');
  }

  return token;
}

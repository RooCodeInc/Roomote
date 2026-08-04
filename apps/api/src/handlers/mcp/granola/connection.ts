import { decrypt } from '@roomote/db/encryption';
import type { McpConnectionGranolaConfig } from '@roomote/types';

class GranolaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GranolaConfigError';
  }
}

export function resolveGranolaApiKey(
  config: McpConnectionGranolaConfig,
): string {
  const apiKey = decrypt(config.encryptedApiKey).trim();

  if (!apiKey) {
    throw new GranolaConfigError(
      'Granola connection is missing a stored API key',
    );
  }

  return apiKey;
}

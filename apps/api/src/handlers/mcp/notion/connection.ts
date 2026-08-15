import { decrypt } from '@roomote/db/encryption';
import type { McpConnectionNotionConfig } from '@roomote/types';

class NotionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotionConfigError';
  }
}

export function resolveNotionAccessToken(
  config: McpConnectionNotionConfig,
): string {
  const token = decrypt(config.encryptedToken).trim();

  if (!token) {
    throw new NotionConfigError(
      'Notion connection is missing a stored internal integration secret',
    );
  }

  return token;
}

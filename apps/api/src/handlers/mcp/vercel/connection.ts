import { decrypt } from '@roomote/db/encryption';
import type { McpConnectionVercelConfig } from '@roomote/types';

class VercelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VercelConfigError';
  }
}

export function resolveVercelAccessToken(
  config: McpConnectionVercelConfig,
): string {
  const token = decrypt(config.encryptedAccessToken).trim();

  if (!token) {
    throw new VercelConfigError('Vercel connection is missing a stored token');
  }

  return token;
}

export function resolveVercelTeamIdOrSlug(
  config: Pick<McpConnectionVercelConfig, 'defaultTeamIdOrSlug'>,
  requestedTeamIdOrSlug?: string,
): string | undefined {
  const teamIdOrSlug =
    requestedTeamIdOrSlug?.trim() || config.defaultTeamIdOrSlug?.trim();

  return teamIdOrSlug && teamIdOrSlug.length > 0 ? teamIdOrSlug : undefined;
}

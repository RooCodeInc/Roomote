import { client } from './client';

/**
 * Check whether an API key exists for the given provider without decrypting
 * or transmitting the secret value. Use this when you only need a boolean
 * toggle (e.g., deciding whether to enable an MCP proxy).
 */
export const hasKey = (provider: string) =>
  client.userApiKeys.hasKey.query({ provider });

/**
 * Returns the decrypted API key for the given provider and current user/org.
 * Use this when the worker needs the raw key (e.g., to pass as an env var
 * to a local tool or other provider-specific client).
 */
export const getDecryptedKey = (provider: string) =>
  client.userApiKeys.getDecryptedKey.query({ provider });

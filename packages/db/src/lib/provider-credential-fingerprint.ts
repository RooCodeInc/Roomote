import { createHmac } from 'node:crypto';

import { getEncryptionKey } from '@roomote/env';

/**
 * Returns a stable, non-secret identifier for grouping provider credentials.
 * This is not a password hash and must remain deterministic for lookups.
 */
export function fingerprintProviderCredential(apiKey: string): string {
  return (
    createHmac('sha256', getEncryptionKey())
      // codeql[js/insufficient-password-hash] -- This keyed HMAC is an identifier, not a password verifier.
      .update(apiKey)
      .digest('hex')
      .slice(0, 12)
  );
}

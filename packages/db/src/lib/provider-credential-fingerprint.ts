import { createHmac } from 'node:crypto';

import { getEncryptionKey } from '@roomote/env';

/**
 * Returns a stable, non-secret grouping identifier using a deployment-keyed HMAC.
 * It is not used for authentication or password storage, so password-KDF semantics do not apply.
 */
export function fingerprintProviderCredential(apiKey: string): string {
  return createHmac('sha256', getEncryptionKey())
    .update(apiKey)
    .digest('hex')
    .slice(0, 12);
}

import { createHmac } from 'node:crypto';

import { getEncryptionKey } from '@roomote/env';

export function fingerprintProviderCredential(apiKey: string): string {
  return createHmac('sha256', getEncryptionKey())
    .update(apiKey)
    .digest('hex')
    .slice(0, 12);
}

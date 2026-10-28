import type { ResolvedBrainInference } from '@roomote/sdk/server';

import { REQUEST_HEADER_DENYLIST } from './constants';
import { copyAllowedHeaders } from './copy-headers';

export function providerHeaders(
  requestHeaders: Headers,
  resolved: ResolvedBrainInference,
  provider: { authHeader: { name: string; scheme?: string } },
): Headers {
  const headers = copyAllowedHeaders(requestHeaders, REQUEST_HEADER_DENYLIST);
  headers.set(
    provider.authHeader.name,
    provider.authHeader.scheme === 'bearer'
      ? `Bearer ${resolved.apiKey}`
      : resolved.apiKey,
  );
  return headers;
}

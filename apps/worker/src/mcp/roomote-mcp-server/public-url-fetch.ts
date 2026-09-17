import {
  publicUrlFetchInputSchema,
  publicUrlFetchMcpResult,
  PUBLIC_URL_FETCH_DEFAULT_TIMEOUT_SECONDS,
  type PublicUrlFetchResult,
} from '@roomote/types';

import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import { catchError } from './tool-result.js';
import type { RoomoteConfig } from './types.js';

export async function handlePublicUrlFetch(
  input: unknown,
  config: RoomoteConfig,
  signal?: AbortSignal,
) {
  try {
    const params = publicUrlFetchInputSchema.parse(input);
    const timeoutMs =
      (params.timeout ?? PUBLIC_URL_FETCH_DEFAULT_TIMEOUT_SECONDS) * 1_000 +
      5_000;
    const response = await fetchWithTimeout(
      `${config.platformApiUrl}/api/mcp/public-url-fetch`,
      {
        method: 'POST',
        headers: buildApiHeaders(config, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(params),
        signal,
      },
      { label: 'Public URL fetch failed', timeoutMs },
    );

    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }

    return publicUrlFetchMcpResult(
      (await response.json()) as PublicUrlFetchResult,
    );
  } catch (error) {
    return catchError(error);
  }
}

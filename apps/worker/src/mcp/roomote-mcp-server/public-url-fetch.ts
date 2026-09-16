import {
  publicUrlFetchInputSchema,
  type PublicUrlFetchResult,
} from '@roomote/types';

import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handlePublicUrlFetch(
  input: unknown,
  config: RoomoteConfig,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    const params = publicUrlFetchInputSchema.parse(input);
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
      { label: 'Public URL fetch failed', timeoutMs: 20_000 },
    );

    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }

    return jsonResult((await response.json()) as PublicUrlFetchResult);
  } catch (error) {
    return catchError(error);
  }
}

import {
  screenshotPreparationInputSchema,
  type ScreenshotPreparationResponse,
} from '@roomote/types';

import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import { catchError, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handlePrepareScreenshot(
  input: unknown,
  config: RoomoteConfig,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    const params = screenshotPreparationInputSchema.parse(input);
    const response = await fetchWithTimeout(
      `${config.platformApiUrl}/api/mcp/screenshot-preparation`,
      {
        method: 'POST',
        headers: buildApiHeaders(config, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(params),
        signal,
      },
      { label: 'Screenshot preparation failed', timeoutMs: 10_000 },
    );

    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }

    const result = (await response.json()) as ScreenshotPreparationResponse;
    return successResult(result as unknown as Record<string, unknown>);
  } catch (error) {
    return catchError(error);
  }
}

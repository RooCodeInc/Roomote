import {
  openArtifactInputSchema,
  type OpenArtifactInput,
} from '@roomote/types';

import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import { errorResult, successResult, catchError } from './tool-result.js';
import type { ArtifactConfig, ToolResult } from './types.js';

export async function handleOpenArtifact(
  input: OpenArtifactInput,
  config: ArtifactConfig,
): Promise<ToolResult> {
  try {
    const body = openArtifactInputSchema.parse(input);
    const response = await fetchWithTimeout(
      `${config.platformApiUrl}/api/mcp/artifacts/open`,
      {
        method: 'POST',
        headers: buildApiHeaders(config, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(body),
      },
      { label: 'Failed to open artifact' },
    );

    if (!response.ok) {
      return errorResult(
        `Failed to open artifact: ${response.status} ${await parseApiError(response)}`,
        { httpStatus: response.status },
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return successResult(payload);
  } catch (error) {
    return catchError(error);
  }
}

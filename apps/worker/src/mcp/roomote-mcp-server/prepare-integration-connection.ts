import { createClient } from '@roomote/sdk/client';
import type { PrepareIntegrationConnectionInput } from '@roomote/types';

import { buildApiHeaders } from './api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handlePrepareIntegrationConnection(
  input: PrepareIntegrationConnectionInput,
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const client = createClient({
      url: config.platformApiUrl,
      headers: () => buildApiHeaders(config),
    });
    return jsonResult(
      await client.mcpConnections.prepareConnection.query(input),
    );
  } catch (error) {
    return catchError(error);
  }
}

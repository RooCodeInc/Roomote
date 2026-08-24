import {
  buildManageCustomAutomationsRequest,
  type ManageCustomAutomationsInput,
} from '@roomote/types';

import type { RoomoteConfig, ToolResult } from './types.js';
import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import { errorResult } from './tool-result.js';

export async function handleManageCustomAutomations(
  params: ManageCustomAutomationsInput,
  config: RoomoteConfig,
): Promise<ToolResult> {
  const built = buildManageCustomAutomationsRequest(params);
  if (!built.ok) return errorResult(built.error);

  const { method, body } = built.request;
  const path = `/api/mcp/custom-automations${built.request.path}`;

  const response = await fetchWithTimeout(
    `${config.platformApiUrl}${path}`,
    {
      method,
      headers: buildApiHeaders(config, {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    { label: 'Failed to manage custom automations' },
  );
  if (!response.ok) {
    return errorResult(
      `Custom automation request failed (${response.status}): ${await parseApiError(response)}`,
    );
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(await response.json(), null, 2),
      },
    ],
  };
}

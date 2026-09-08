import type { CreateSkillInput } from '@roomote/types';

import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import { catchError, errorResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleCreateSkill(
  params: CreateSkillInput,
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const response = await fetchWithTimeout(
      `${config.platformApiUrl}/api/mcp/custom-skills`,
      {
        method: 'POST',
        headers: buildApiHeaders(config, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(params),
      },
      { label: 'Failed to create skill' },
    );
    if (!response.ok) {
      return errorResult(await parseApiError(response), {
        httpStatus: response.status,
      });
    }
    const payload: unknown = await response.json();
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (error) {
    return catchError(error);
  }
}

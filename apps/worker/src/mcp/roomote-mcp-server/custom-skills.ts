import {
  createCustomSkillInputSchema,
  type CreateCustomSkillInput,
} from '@roomote/types';

import { buildApiHeaders, fetchWithTimeout } from './api-client.js';
import { errorResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleCreateCustomSkill(
  params: CreateCustomSkillInput,
  config: RoomoteConfig,
): Promise<ToolResult> {
  const body = createCustomSkillInputSchema.parse(params);
  const response = await fetchWithTimeout(
    `${config.platformApiUrl}/api/mcp/custom-skills`,
    {
      method: 'POST',
      headers: buildApiHeaders(config, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    },
    { label: 'Failed to create custom skill' },
  );
  const raw: unknown = await response.json().catch(() => null);
  const payload =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (!response.ok) {
    return errorResult(
      typeof payload.error === 'string'
        ? payload.error
        : `Custom skill request failed (${response.status})`,
      { httpStatus: response.status },
    );
  }

  const { success, persisted, skillId, name, scope } = payload;
  if (
    success !== true ||
    persisted !== true ||
    typeof skillId !== 'string' ||
    typeof name !== 'string' ||
    scope !== 'instance'
  ) {
    return {
      ...errorResult('Custom skill persistence could not be confirmed.'),
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { success, persisted, skillId, name, scope },
          null,
          2,
        ),
      },
    ],
  };
}

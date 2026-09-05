import { getSessionUpdates, getTaskUpdates } from './tasks-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleGetRelayUpdates(
  params: {
    target: { kind: 'task' | 'session'; id: string };
    limit?: number;
    cursor?: string;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const request = { limit: params.limit, cursor: params.cursor };
    const result =
      params.target.kind === 'task'
        ? await getTaskUpdates(config, params.target.id, request)
        : await getSessionUpdates(config, params.target.id, request);
    return jsonResult(result);
  } catch (error) {
    return catchError(error);
  }
}

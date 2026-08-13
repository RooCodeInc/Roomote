import { listTaskModels } from './tasks-api-client.js';
import { catchError, textResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleListTaskModels(
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return textResult(JSON.stringify(await listTaskModels(config), null, 2));
  } catch (error) {
    return catchError(error);
  }
}

import { getTaskComputeLogs } from './tasks-api-client.js';
import { catchError, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleGetTaskComputeLogs(
  params: { taskId: string },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await getTaskComputeLogs(config, params.taskId);
    return successResult({
      taskId: result.taskId,
      returned: result.returned,
      taskRuns: result.taskRuns,
    });
  } catch (error) {
    return catchError(error);
  }
}

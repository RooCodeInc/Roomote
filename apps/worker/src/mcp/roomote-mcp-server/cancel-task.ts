import { cancelTask } from './tasks-api-client.js';
import { errorResult, successResult, catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleCancelTask(
  params: { taskId: string },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await cancelTask(config, params.taskId);

    if (!result.success) {
      return errorResult(result.error || 'Failed to cancel task');
    }

    return successResult({
      message: `Task ${params.taskId} has been canceled.`,
    });
  } catch (error) {
    return catchError(error);
  }
}

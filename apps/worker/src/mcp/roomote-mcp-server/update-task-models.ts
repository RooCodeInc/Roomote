import { updateTaskModelSelection } from './tasks-api-client.js';
import { errorResult, successResult, catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const APPLICATION_MESSAGES: Record<string, string> = {
  restarted: 'The new model settings are active now.',
  deferred: 'The new model settings apply from the next turn.',
  unavailable:
    'The selection was saved, but the sandbox is shutting down; it applies when the task resumes.',
  offline: 'The selection was saved and applies when the task resumes.',
};

export async function handleUpdateTaskModels(
  params: {
    taskId: string;
    role: string;
    model?: string | null;
    reasoningEffort?: string | null;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await updateTaskModelSelection(config, params.taskId, {
      role: params.role,
      model: params.model ?? null,
      reasoningEffort: params.reasoningEffort ?? null,
    });

    if (!result.success) {
      return errorResult(
        result.error || 'Failed to update the task model selection',
      );
    }

    return successResult({
      message: `Updated the ${params.role} model selection. ${
        APPLICATION_MESSAGES[result.application ?? 'offline'] ??
        'The selection was saved.'
      }`,
    });
  } catch (error) {
    return catchError(error);
  }
}

import { getTaskSummary } from './tasks-api-client.js';
import { getHarnessLabel, getTaskStatusLabel } from './task-display.js';
import { textResult, catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleGetTaskSummary(
  params: { taskId: string },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await getTaskSummary(config, params.taskId);
    const harnessLabel = getHarnessLabel(result.harness);

    const lines = [
      `Task: ${result.title || '(untitled)'}`,
      `ID: ${result.id}`,
      `Status: ${getTaskStatusLabel(result)}`,
      result.mode ? `Mode: ${result.mode}` : null,
      harnessLabel ? `Harness: ${harnessLabel}` : null,
      result.repositoryName ? `Repository: ${result.repositoryName}` : null,
      result.linkedEnvironmentName
        ? `Linked Environment: ${result.linkedEnvironmentName}`
        : null,
      result.linkedEnvironmentId
        ? `Linked Environment ID: ${result.linkedEnvironmentId}`
        : null,
      result.cloudJobError ? `Error: ${result.cloudJobError}` : null,
    ].filter(Boolean);

    return textResult(lines.join('\n'));
  } catch (error) {
    return catchError(error);
  }
}

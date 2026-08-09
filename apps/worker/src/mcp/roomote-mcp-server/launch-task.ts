import { ALL_REPOSITORIES } from '@roomote/types';

import { launchTask } from './tasks-api-client.js';
import { errorResult, successResult, catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleLaunchTask(
  params: {
    prompt: string;
    branch?: string;
    environmentId: string;
    notifyOnSettle?: boolean;
    reportToSource?: boolean;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await launchTask(config, {
      prompt: params.prompt,
      repo: ALL_REPOSITORIES,
      branch: params.branch,
      environmentId:
        params.environmentId === ALL_REPOSITORIES
          ? undefined
          : params.environmentId,
      type: 'standard',
      ...(params.notifyOnSettle ? { notifyOnSettle: true } : {}),
      ...(params.reportToSource ? { reportToSource: true } : {}),
    });

    if (!result.success) {
      return errorResult(result.error || 'Failed to launch task');
    }

    return successResult({
      runId: result.runId,
      taskId: result.taskId,
      message: `Task launched successfully. Task Run ID: ${result.runId}, Task ID: ${result.taskId}`,
    });
  } catch (error) {
    return catchError(error);
  }
}

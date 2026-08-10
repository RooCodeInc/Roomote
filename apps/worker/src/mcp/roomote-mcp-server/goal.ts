import { sdk } from '@roomote/sdk/client';

import { catchError, errorResult, successResult } from './tool-result.js';
import type { ToolResult } from './types.js';

function currentRunId(): number | null {
  const runId = Number(process.env.ROOMOTE_TASK_RUN_ID);
  return Number.isInteger(runId) && runId > 0 ? runId : null;
}

export async function handleManageGoal(params: {
  action: 'get' | 'complete' | 'blocked';
  reason?: string;
}): Promise<ToolResult> {
  const runId = currentRunId();
  if (!runId) {
    return errorResult('ROOMOTE_TASK_RUN_ID environment variable not set');
  }

  try {
    if (params.action === 'get') {
      const goal = await sdk.taskRuns.getGoal({ runId });
      return successResult({ goal });
    }

    if (params.action === 'blocked' && !params.reason?.trim()) {
      return errorResult('reason is required when marking a goal blocked');
    }

    const result =
      params.action === 'complete'
        ? await sdk.taskRuns.markGoalComplete({ runId })
        : await sdk.taskRuns.markGoalBlocked({
            runId,
            reason: params.reason!.trim(),
          });

    return successResult(result);
  } catch (error) {
    return catchError(error);
  }
}

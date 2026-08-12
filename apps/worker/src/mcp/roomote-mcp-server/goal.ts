import { sdk } from '@roomote/sdk/client';
import type { TaskGoal } from '@roomote/types';

import { catchError, errorResult, successResult } from './tool-result.js';
import type { ToolResult } from './types.js';

function currentRunId(): number | null {
  const runId = Number(process.env.ROOMOTE_TASK_RUN_ID);
  return Number.isInteger(runId) && runId > 0 ? runId : null;
}

function withoutGeneration(goal: TaskGoal | null) {
  if (!goal) {
    return null;
  }

  const { generation: _generation, ...visibleGoal } = goal;
  return visibleGoal;
}

export async function handleManageGoal(params: {
  action: 'get' | 'complete' | 'blocked';
  generation?: string | null;
  reason?: string;
}): Promise<ToolResult> {
  const runId = currentRunId();
  if (!runId) {
    return errorResult('ROOMOTE_TASK_RUN_ID environment variable not set');
  }

  try {
    if (params.action === 'get') {
      const goal = await sdk.taskRuns.getGoal({ runId });
      return successResult({ goal: withoutGeneration(goal) });
    }

    if (params.action === 'blocked' && !params.reason?.trim()) {
      return errorResult('reason is required when marking a goal blocked');
    }
    if (params.generation === undefined) {
      return errorResult(
        'generation is required when marking a goal complete or blocked',
      );
    }

    const result =
      params.action === 'complete'
        ? await sdk.taskRuns.markGoalComplete({
            runId,
            generation: params.generation,
          })
        : await sdk.taskRuns.markGoalBlocked({
            runId,
            generation: params.generation,
            reason: params.reason!.trim(),
          });

    return successResult({
      ...result,
      goal: withoutGeneration(result.goal),
    });
  } catch (error) {
    return catchError(error);
  }
}

import { getRoomoteConfig } from './config.js';
import { getTaskGoal, updateTaskGoal } from './tasks-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { TaskGoalWire, ToolResult } from './types.js';

function currentRunId(): number | null {
  const runId = Number(process.env.ROOMOTE_TASK_RUN_ID);
  return Number.isInteger(runId) && runId > 0 ? runId : null;
}

function withoutGeneration(goal: TaskGoalWire | null) {
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

  const config = getRoomoteConfig();
  if (!config) {
    return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
  }

  try {
    if (params.action === 'get') {
      const { goal } = await getTaskGoal(config, runId);
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
        ? await updateTaskGoal(config, runId, {
            action: 'complete',
            generation: params.generation,
          })
        : await updateTaskGoal(config, runId, {
            action: 'blocked',
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

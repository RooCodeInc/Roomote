import fs from 'node:fs';

import { MAX_TASK_WAIT_MS, MIN_TASK_WAIT_MS } from '@roomote/types';

import { getRoomoteConfig } from './config.js';
import { waitCurrentTask } from './tasks-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { ToolResult } from './types.js';

function currentRunId(): number | null {
  const runId = Number(process.env.ROOMOTE_TASK_RUN_ID);
  return Number.isInteger(runId) && runId > 0 ? runId : null;
}

export async function handleWaitTask(params: {
  delaySeconds: number;
  reason: string;
}): Promise<ToolResult> {
  const runId = currentRunId();
  if (!runId) {
    return errorResult('ROOMOTE_TASK_RUN_ID environment variable not set');
  }
  if (
    params.delaySeconds < MIN_TASK_WAIT_MS / 1_000 ||
    params.delaySeconds > MAX_TASK_WAIT_MS / 1_000
  ) {
    return errorResult(
      `delaySeconds must be between ${MIN_TASK_WAIT_MS / 1_000} and ${MAX_TASK_WAIT_MS / 1_000}`,
    );
  }

  const config = getRoomoteConfig();
  if (!config) {
    return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
  }

  try {
    const result = await waitCurrentTask(config, runId, {
      delaySeconds: params.delaySeconds,
      reason: params.reason.trim(),
    });
    if (!result.scheduled) {
      return errorResult(
        result.waitUntil
          ? `Task wait was not scheduled (${result.reason}); existing wake is ${result.waitUntil}.`
          : `Task wait was not scheduled (${result.reason}).`,
      );
    }
    const waitStatePath = process.env.ROOMOTE_TASK_WAIT_STATE_FILE?.trim();
    if (waitStatePath) {
      fs.writeFileSync(waitStatePath, JSON.stringify(result), 'utf8');
    }
    return successResult({
      ...result,
      instruction:
        'The wait is scheduled. On chat-started tasks, post the paused-state closeout now, then end the turn without doing more work.',
    });
  } catch (error) {
    return catchError(error);
  }
}

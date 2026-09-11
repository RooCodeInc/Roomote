import { getRoomoteConfig } from './config.js';
import { updatePersonalization } from './tasks-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { ToolResult } from './types.js';

export async function handleUpdatePersonalization(input: {
  preference: string;
  confidence: 'explicit' | 'inferred';
}): Promise<ToolResult> {
  const runId = Number(process.env.ROOMOTE_TASK_RUN_ID);
  const config = getRoomoteConfig();
  if (!Number.isInteger(runId) || runId <= 0 || !config) {
    return errorResult('Roomote task credentials are not available');
  }

  try {
    const result = await updatePersonalization(config, runId, input);
    return successResult(
      result.saved
        ? { saved: true }
        : { saved: false, reason: result.reason ?? 'Not saved.' },
    );
  } catch (error) {
    return catchError(error);
  }
}

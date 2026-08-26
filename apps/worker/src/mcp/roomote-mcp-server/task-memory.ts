import { getRoomoteConfig } from './config.js';
import { saveTaskMemory } from './tasks-api-client.js';
import { successResult, errorResult, catchError } from './tool-result.js';
import type { ToolResult } from './types.js';

function currentRunId(): number | null {
  const runId = Number(process.env.ROOMOTE_TASK_RUN_ID);
  return Number.isInteger(runId) && runId > 0 ? runId : null;
}

/**
 * Agent-authored task memory: the agent writes what only it knows (what it
 * decided and why), and the platform places that text in the Brain under a
 * server-chosen slug after redaction. The agent never holds a Brain write
 * credential and cannot reach any page but its own task's.
 */
export async function handleSaveTaskMemory(input: {
  outcome: string;
  decisions?: string[];
  rationale?: string;
  reusableFacts?: string[];
  unresolvedQuestions?: string[];
}): Promise<ToolResult> {
  const runId = currentRunId();

  if (!runId) {
    return errorResult('ROOMOTE_TASK_RUN_ID environment variable not set');
  }

  try {
    const config = getRoomoteConfig();

    if (!config) {
      return errorResult('Roomote platform credentials are not available');
    }

    const result = await saveTaskMemory(config, runId, input);

    return successResult(
      result.saved
        ? {
            saved: true,
            note: 'Recorded for the shared Brain.',
            memory: input,
          }
        : {
            saved: false,
            reason: result.reason ?? 'Not saved.',
            memory: input,
          },
    );
  } catch (error) {
    return catchError(error);
  }
}

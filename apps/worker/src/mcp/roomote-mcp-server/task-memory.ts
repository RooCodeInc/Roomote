import { redactBrainTextFragments } from '@roomote/communication/redact-brain-text';

import { getRoomoteConfig } from './config.js';
import { saveTaskMemory } from './tasks-api-client.js';
import { successResult, errorResult, catchError } from './tool-result.js';
import type { ToolResult } from './types.js';

type TaskMemoryInput = {
  outcome: string;
  decisions?: string[];
  rationale?: string;
  reusableFacts?: string[];
  unresolvedQuestions?: string[];
};

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
export async function handleSaveTaskMemory(
  input: TaskMemoryInput,
): Promise<ToolResult> {
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
    const fragments = [
      input.outcome,
      ...(input.rationale !== undefined ? [input.rationale] : []),
      ...(input.decisions ?? []),
      ...(input.reusableFacts ?? []),
      ...(input.unresolvedQuestions ?? []),
    ];
    const redactedFragments = redactBrainTextFragments(fragments);
    let fragmentIndex = 0;
    const takeFragment = () => redactedFragments[fragmentIndex++]!;
    const outcome = takeFragment();
    const rationale =
      input.rationale !== undefined ? takeFragment() : undefined;
    const decisions = input.decisions?.map(() => takeFragment());
    const reusableFacts = input.reusableFacts?.map(() => takeFragment());
    const unresolvedQuestions = input.unresolvedQuestions?.map(() =>
      takeFragment(),
    );
    const memory = {
      outcome,
      ...(input.decisions !== undefined ? { decisions } : {}),
      ...(input.rationale !== undefined ? { rationale } : {}),
      ...(input.reusableFacts !== undefined ? { reusableFacts } : {}),
      ...(input.unresolvedQuestions !== undefined
        ? { unresolvedQuestions }
        : {}),
    };

    return successResult(
      result.saved
        ? {
            saved: true,
            note: 'Recorded for the shared Brain.',
            memory,
          }
        : {
            saved: false,
            reason: result.reason ?? 'Not saved.',
            memory,
          },
    );
  } catch (error) {
    return catchError(error);
  }
}

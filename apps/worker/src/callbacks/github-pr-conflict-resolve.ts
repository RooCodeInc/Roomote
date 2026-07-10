import {
  CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY,
  parseConflictResolutionSummary,
} from '@roomote/types';
import { type TaskRun, sdk } from '@roomote/sdk/client';

import type {
  CallbackEvent,
  RunTaskCallbacks,
  RunTaskContext,
} from '../run-task';

function getExistingResult(taskRun: TaskRun): Record<string, unknown> {
  if (
    !taskRun.result ||
    typeof taskRun.result !== 'object' ||
    Array.isArray(taskRun.result)
  ) {
    return {};
  }

  return taskRun.result as Record<string, unknown>;
}

export const githubPrConflictResolveCallbacks: RunTaskCallbacks = {
  onMessage: async (
    taskRun: TaskRun,
    _taskId: string,
    event: CallbackEvent,
    context: RunTaskContext,
  ) => {
    if (event.type !== 'completion') {
      return;
    }

    if (context.conflictResolutionCompletionTs === event.ts) {
      return;
    }

    context.conflictResolutionCompletionTs = event.ts;

    const summary = parseConflictResolutionSummary(event.text);

    if (!summary) {
      return;
    }

    context.conflictResolutionSummary = summary;

    const nextResult = {
      ...getExistingResult(taskRun),
      [CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY]: summary,
    };

    await sdk.taskRuns.update({
      id: taskRun.id,
      result: nextResult,
    });

    taskRun.result = nextResult;
  },
};

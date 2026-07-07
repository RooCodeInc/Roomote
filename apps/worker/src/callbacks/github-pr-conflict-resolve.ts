import {
  CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY,
  parseConflictResolutionSummary,
} from '@roomote/types';
import { type CloudJob, sdk } from '@roomote/sdk/client';

import type {
  CallbackEvent,
  RunTaskCallbacks,
  RunTaskContext,
} from '../run-task';

function getExistingResult(cloudJob: CloudJob): Record<string, unknown> {
  if (
    !cloudJob.result ||
    typeof cloudJob.result !== 'object' ||
    Array.isArray(cloudJob.result)
  ) {
    return {};
  }

  return cloudJob.result as Record<string, unknown>;
}

export const githubPrConflictResolveCallbacks: RunTaskCallbacks = {
  onMessage: async (
    cloudJob: CloudJob,
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
      ...getExistingResult(cloudJob),
      [CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY]: summary,
    };

    await sdk.cloudJobs.update({
      id: cloudJob.id,
      result: nextResult,
    });

    cloudJob.result = nextResult;
  },
};

import { RunStatus } from '@roomote/types';

import type { RunTaskState } from './types';

function formatResolvedError(
  state: RunTaskState,
  fallbackMessage: string,
): string {
  return state.lastErrorMessage || fallbackMessage;
}

export function resolveStatus(state: RunTaskState): {
  status: RunStatus;
  error?: string;
} {
  if (state.taskAbortedAt) {
    return {
      status: RunStatus.Canceled,
      error: formatResolvedError(state, 'Task aborted'),
    };
  }

  if (state.taskFinishedAt) {
    return { status: RunStatus.Completed };
  }

  return {
    status: RunStatus.Failed,
    error: formatResolvedError(state, 'Task failed to complete'),
  };
}

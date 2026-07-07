import { CloudTaskStatus } from '@roomote/types';

import type { RunTaskState } from './types';

function formatResolvedError(
  state: RunTaskState,
  fallbackMessage: string,
): string {
  return state.lastErrorMessage || fallbackMessage;
}

export function resolveStatus(state: RunTaskState): {
  status: CloudTaskStatus;
  error?: string;
} {
  if (state.taskAbortedAt) {
    return {
      status: CloudTaskStatus.Canceled,
      error: formatResolvedError(state, 'Task aborted'),
    };
  }

  if (state.taskFinishedAt) {
    return { status: CloudTaskStatus.Completed };
  }

  return {
    status: CloudTaskStatus.Failed,
    error: formatResolvedError(state, 'Task failed to complete'),
  };
}

import type { TaskStatusEvent } from '@roomote/types';

/**
 * Preserve the live task phases that materially affect the task UI, while
 * still collapsing disconnected/background-only phases down to idle.
 */
export function normalizeTaskStatusEventForClient(
  status: TaskStatusEvent,
): TaskStatusEvent {
  if (
    status.isConnected &&
    (status.phase === 'running' || status.phase === 'waiting_for_user_input')
  ) {
    return status;
  }

  return { ...status, phase: 'idle' };
}

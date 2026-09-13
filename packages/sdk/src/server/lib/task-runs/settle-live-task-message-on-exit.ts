import { RunStatus } from '@roomote/types';
import { settleSlackLiveTaskCardForRun } from '@roomote/slack';

import { settleTelegramLiveTaskStreamForRun } from '../telegram-live-task-stream';

/**
 * Settle a run's provider-native live task message for terminations the worker never sees
 * (cancel before dequeue, reaper finalization, failed bootstrap). Only
 * Failed/Canceled are settled here: a run completes only through a live
 * worker, which renders the real output itself. Never throws: callers run
 * this detached from the settle path.
 */
export async function settleLiveTaskMessageOnExit(
  run: { id: number; taskId: string; payload: unknown },
  status: RunStatus,
  taskTitle?: string | null,
): Promise<void> {
  if (status !== RunStatus.Failed && status !== RunStatus.Canceled) {
    return;
  }

  try {
    await settleSlackLiveTaskCardForRun({
      taskId: run.taskId,
      payload: run.payload,
      status,
      taskTitle,
    });
    await settleTelegramLiveTaskStreamForRun({
      taskId: run.taskId,
      payload: run.payload,
      status,
    });
  } catch (error) {
    console.error(
      `[settleLiveTaskMessageOnExit] Failed for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

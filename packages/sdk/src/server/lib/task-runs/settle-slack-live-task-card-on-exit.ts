import { RunStatus } from '@roomote/types';
import { settleSlackLiveTaskCardForRun } from '@roomote/slack';

/**
 * Settle a run's Slack task card for terminations the worker never sees
 * (cancel before dequeue, reaper finalization, failed bootstrap). Only
 * Failed/Canceled are settled here: a run completes only through a live
 * worker, which renders the real output itself. Never throws: callers run
 * this detached from the settle path.
 */
export async function settleSlackLiveTaskCardOnExit(
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
  } catch (error) {
    console.error(
      `[settleSlackLiveTaskCardOnExit] Failed for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

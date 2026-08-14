import { findTaskWaitsNeedingWake } from '@roomote/db/server';
import { enqueueTaskWake } from '@roomote/sdk/server';

const TASK_WAKE_RECOVERY_BATCH_SIZE = 500;

export async function taskWakeRecoveryJob(): Promise<void> {
  const dueWaits = await findTaskWaitsNeedingWake({
    limit: TASK_WAKE_RECOVERY_BATCH_SIZE,
  });

  for (const wait of dueWaits) {
    try {
      await enqueueTaskWake({
        runId: wait.id,
        waitUntil: wait.waitUntil.toISOString(),
      });
    } catch (error) {
      console.error(
        `[TaskWakeRecovery] Failed to enqueue due wait for run #${wait.id}:`,
        error,
      );
    }
  }
}

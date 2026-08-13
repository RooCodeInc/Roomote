import {
  and,
  asc,
  db,
  isNotNull,
  isNull,
  lte,
  taskRuns,
} from '@roomote/db/server';
import { enqueueTaskWake } from '@roomote/sdk/server';

const TASK_WAKE_RECOVERY_BATCH_SIZE = 500;

export async function taskWakeRecoveryJob(): Promise<void> {
  const dueWaits = await db
    .select({ id: taskRuns.id, waitUntil: taskRuns.waitUntil })
    .from(taskRuns)
    .where(
      and(
        isNotNull(taskRuns.waitUntil),
        lte(taskRuns.waitUntil, new Date()),
        isNull(taskRuns.waitResumedAt),
        isNull(taskRuns.waitResumeRunId),
      ),
    )
    .orderBy(asc(taskRuns.waitUntil))
    .limit(TASK_WAKE_RECOVERY_BATCH_SIZE);

  for (const wait of dueWaits) {
    if (!wait.waitUntil) continue;

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

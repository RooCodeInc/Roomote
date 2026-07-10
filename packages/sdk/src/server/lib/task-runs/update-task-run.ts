import { type UpdateTaskRun, db, taskRuns, eq } from '@roomote/db/server';

export async function updateTaskRun(
  runId: number,
  values: UpdateTaskRun,
): Promise<void> {
  try {
    await db.update(taskRuns).set(values).where(eq(taskRuns.id, runId));
  } catch (error) {
    console.error(
      `[updateTaskRun] Failed to update task run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

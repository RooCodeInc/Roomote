import { type UpdateTaskRun, db, taskRuns, eq } from '@roomote/db/server';
import { RunStatus } from '@roomote/types';
import { notifyTaskRunThreadFooterRefresh } from '../thread-footer-refresh';

export async function updateTaskRun(
  runId: number,
  values: UpdateTaskRun,
): Promise<void> {
  try {
    await db.update(taskRuns).set(values).where(eq(taskRuns.id, runId));
    if (values.status === RunStatus.Running) {
      notifyTaskRunThreadFooterRefresh(runId);
    }
  } catch (error) {
    console.error(
      `[updateTaskRun] Failed to update task run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
  type SlackLiveTaskStreamData,
} from '@roomote/slack';
import { db, eq, taskRuns } from '@roomote/db/server';

/**
 * Serve the run's live task-card data to workers. The data lives in
 * control-plane Redis keyed by task id (stable across snapshot resumes);
 * sandboxed workers can only reach it through this API.
 *
 * The card title tracks the task's generated title once one exists (the
 * launcher only had the raw prompt when it posted the card).
 */
export async function getSlackLiveTaskStreamDataForRun(
  runId: number,
): Promise<SlackLiveTaskStreamData | null> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true },
    with: { task: { columns: { title: true } } },
  });
  if (!run) {
    return null;
  }

  const data = await getSlackLiveTaskStreamData(run.taskId);
  if (!data) {
    return null;
  }

  const taskTitle = run.task?.title?.trim();

  return taskTitle
    ? { ...data, title: buildSlackLiveTaskTitle(taskTitle) }
    : data;
}

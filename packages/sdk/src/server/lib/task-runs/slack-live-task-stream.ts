import {
  buildSlackLiveTaskTitle,
  clearSlackLiveTaskStreamData,
  getSlackLiveTaskStreamData,
  type SlackLiveTaskStreamData,
} from '@roomote/slack';
import { db, eq, taskRuns, tasks } from '@roomote/db/server';

/**
 * Serve the run's live task-card data to workers. The data lives in
 * control-plane Redis keyed by task id (stable across snapshot resumes);
 * sandboxed workers can only reach it through this API.
 *
 * The card title tracks the task's generated title once one exists (the
 * launcher only had the raw prompt at stream-start time); task_update
 * titles replace on append, so the worker's next update renames the card.
 */
export async function getSlackLiveTaskStreamDataForRun(
  runId: number,
): Promise<SlackLiveTaskStreamData | null> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true },
  });
  if (!run) {
    return null;
  }

  const data = await getSlackLiveTaskStreamData(run.taskId);
  if (!data) {
    return null;
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, run.taskId),
    columns: { title: true },
  });
  const taskTitle = task?.title?.trim();

  return taskTitle
    ? { ...data, title: buildSlackLiveTaskTitle(taskTitle) }
    : data;
}

export async function clearSlackLiveTaskStreamDataForRun(
  runId: number,
): Promise<void> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true },
  });

  if (run) {
    await clearSlackLiveTaskStreamData(run.taskId);
  }
}

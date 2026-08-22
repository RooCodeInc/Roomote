import {
  renderSlackLiveTaskCard,
  type SlackLiveTaskCardRenderResult,
  type SlackLiveTaskCardRenderStatus,
} from '@roomote/slack';
import { db, eq, taskRuns } from '@roomote/db/server';

/**
 * Render a run's live task card on the worker's behalf. The card pointer
 * lives in control-plane Redis keyed by task id (stable across snapshot
 * resumes) and the workspace's bot token never leaves the control plane:
 * sandboxed workers only ever send the state they want shown.
 *
 * The card title tracks the task's generated title once one exists (the
 * launcher only had the raw prompt when it posted the card).
 */
export async function renderSlackLiveTaskCardForRun(
  runId: number,
  input: { status: SlackLiveTaskCardRenderStatus; message?: string },
): Promise<SlackLiveTaskCardRenderResult> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true },
    with: { task: { columns: { title: true } } },
  });
  if (!run) {
    return { card: false, updated: false };
  }

  return renderSlackLiveTaskCard({
    taskId: run.taskId,
    status: input.status,
    ...(input.message ? { message: input.message } : {}),
    taskTitle: run.task?.title,
  });
}

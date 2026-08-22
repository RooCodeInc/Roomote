import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
  type SlackLiveTaskStreamData,
} from '@roomote/slack';
import { and, db, eq, slackInstallations, taskRuns } from '@roomote/db/server';

/** Card data plus the credential for the one workspace that owns the card. */
type SlackLiveTaskCardAccess = SlackLiveTaskStreamData & {
  botAccessToken: string;
};

/**
 * Serve the run's live task-card data to workers. The data lives in
 * control-plane Redis keyed by task id (stable across snapshot resumes);
 * sandboxed workers can only reach it through this run-scoped API.
 *
 * The bot token is resolved here from the card's own team id, so a run can
 * only ever obtain the credential of the workspace its card lives in, never
 * an arbitrary installation's.
 *
 * The card title tracks the task's generated title once one exists (the
 * launcher only had the raw prompt when it posted the card).
 */
export async function getSlackLiveTaskStreamDataForRun(
  runId: number,
): Promise<SlackLiveTaskCardAccess | null> {
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

  const installation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(slackInstallations.isActive, true),
      eq(slackInstallations.teamId, data.teamId),
    ),
    columns: { botAccessToken: true },
  });
  if (!installation?.botAccessToken) {
    return null;
  }

  const taskTitle = run.task?.title?.trim();

  return {
    ...data,
    ...(taskTitle ? { title: buildSlackLiveTaskTitle(taskTitle) } : {}),
    botAccessToken: installation.botAccessToken,
  };
}

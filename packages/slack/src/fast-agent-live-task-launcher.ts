import {
  createFastAgentSlackTaskLauncher,
  type FastAgentSlackTaskLauncherParams,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { db, eq, tasks } from '@roomote/db/server';

import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData,
} from './live-task-stream';
import type { SlackNotifier } from './slack-notifier';

type SlackLiveTaskStreamNotifier = Pick<
  SlackNotifier,
  'startTaskStream' | 'appendTaskStream'
>;

/**
 * Fast delegation launcher that also opens a native Slack task card in the
 * parent thread. The worker keeps the card updated for the task's lifetime
 * through the run-scoped live-stream API.
 */
export function createFastAgentSlackLiveTaskLauncher(
  params: Omit<
    FastAgentSlackTaskLauncherParams,
    'liveTaskStream' | 'afterKickoff' | 'afterLaunch'
  > & {
    slack: SlackLiveTaskStreamNotifier;
    /** Slack user the card is addressed to (the delegating human). */
    recipientUserId?: string;
  },
): LaunchFastAgentTask {
  const { slack, recipientUserId, ...launcherParams } = params;

  const startLiveTaskStream = async (
    taskRun: { id: number; taskId: string },
    context: { prompt: string; taskUrl: string },
  ): Promise<void> => {
    try {
      // A card for this task already exists (for example an idempotent
      // relaunch of the same task); keep updating it instead of starting
      // a second stream in the thread.
      if (await getSlackLiveTaskStreamData(taskRun.taskId)) {
        return;
      }

      const title = buildSlackLiveTaskTitle(context.prompt);
      const taskUpdateId = `roomote-task-${taskRun.taskId}`;
      // One entry whose title always shows the CURRENT step (the worker
      // title-swaps it per todo; only title/status replace on append).
      // The task link is sent exactly once (Slack accumulates sources),
      // and the settled card returns to the task title with the output.
      const initialTask = {
        id: taskUpdateId,
        title,
        // A pending-only stream does not render; start in_progress so the
        // card is visible with the kickoff instead of materializing only
        // at the worker's first update.
        status: 'in_progress' as const,
        sources: [
          { type: 'url' as const, url: context.taskUrl, text: 'View task' },
        ],
      };
      const messageTs = await slack.startTaskStream({
        channel: launcherParams.channelId,
        threadTs: launcherParams.threadTs,
        recipientTeamId: launcherParams.teamId,
        ...(recipientUserId ? { recipientUserId } : {}),
        task: initialTask,
      });

      if (!messageTs) {
        return;
      }

      // The Slack client does not paint a stream whose only content is
      // the opening chunk; re-append the entry so the card renders
      // immediately instead of waiting for the worker's first update.
      // Sources are deliberately omitted: Slack appends them per chunk
      // instead of replacing, so the link is sent exactly once.
      await slack.appendTaskStream({
        channel: launcherParams.channelId,
        messageTs,
        task: {
          id: initialTask.id,
          title: initialTask.title,
          status: initialTask.status,
        },
      });

      await setSlackLiveTaskStreamData(taskRun.taskId, {
        channel: launcherParams.channelId,
        messageTs,
        taskId: taskRun.taskId,
        taskUpdateId,
        threadTs: launcherParams.threadTs,
        title,
        taskUrl: context.taskUrl,
      });
    } catch (error) {
      console.error(
        `[Fast Agent] Failed to start Slack live task stream for run ${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // The generated task title usually lands shortly after enqueue, well
  // before the worker's first event; refresh the card's opening
  // (prompt-derived) title as soon as it exists. Bounded to the
  // pre-worker window so it never overwrites a step title (the worker
  // also pushes the generated title itself on start).
  const refreshLiveTaskCardTitle = async ({
    taskId,
  }: {
    taskId: string;
  }): Promise<void> => {
    try {
      for (const delayMs of [0, 3_000, 8_000, 15_000, 30_000]) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        const [data, taskRow] = await Promise.all([
          getSlackLiveTaskStreamData(taskId),
          db.query.tasks.findFirst({
            where: eq(tasks.id, taskId),
            columns: { title: true },
          }),
        ]);
        const generatedTitle = taskRow?.title?.trim();
        if (!data) {
          return;
        }
        if (!generatedTitle) {
          continue;
        }

        const title = buildSlackLiveTaskTitle(generatedTitle);
        if (title === data.title) {
          return;
        }

        await slack.appendTaskStream({
          channel: data.channel,
          messageTs: data.messageTs,
          task: { id: data.taskUpdateId, title, status: 'in_progress' },
        });
        await setSlackLiveTaskStreamData(taskId, { ...data, title });
        return;
      }
    } catch (error) {
      console.error(
        `[Fast Agent] Failed to refresh live task card title for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return createFastAgentSlackTaskLauncher({
    ...launcherParams,
    liveTaskStream: true,
    afterKickoff: startLiveTaskStream,
    afterLaunch: refreshLiveTaskCardTitle,
  });
}

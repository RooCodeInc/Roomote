import {
  createFastAgentSlackTaskLauncher,
  type FastAgentSlackTaskLauncherParams,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { db, eq, tasks } from '@roomote/db/server';

import { buildSlackLiveTaskCardBlocks } from './live-task-card-blocks';
import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData,
} from './live-task-stream';
import type { SlackNotifier } from './slack-notifier';

type SlackLiveTaskCardNotifier = Pick<
  SlackNotifier,
  'postMessage' | 'updateMessage'
>;

/**
 * Fast delegation launcher that also posts a native task card (a
 * `task_card` block) in the parent thread. The worker re-renders the whole
 * card through chat.update for the task's lifetime, so it always shows the
 * latest state instead of an accumulating stream.
 */
export function createFastAgentSlackLiveTaskLauncher(
  params: Omit<
    FastAgentSlackTaskLauncherParams,
    'liveTaskStream' | 'afterKickoff' | 'afterLaunch'
  > & {
    slack: SlackLiveTaskCardNotifier;
  },
): LaunchFastAgentTask {
  const { slack, ...launcherParams } = params;

  const startLiveTaskCard = async (
    taskRun: { id: number; taskId: string },
    context: { prompt: string; taskUrl: string },
  ): Promise<void> => {
    try {
      // A card for this task already exists (for example an idempotent
      // relaunch of the same task); keep updating it instead of posting
      // a second card in the thread.
      if (await getSlackLiveTaskStreamData(taskRun.taskId)) {
        return;
      }

      const title = buildSlackLiveTaskTitle(context.prompt);
      const taskUpdateId = `roomote-task-${taskRun.taskId}`;
      const messageTs = await slack.postMessage({
        channel: launcherParams.channelId,
        thread_ts: launcherParams.threadTs,
        ...buildSlackLiveTaskCardBlocks({
          taskUpdateId,
          title,
          status: 'in_progress',
          step: 'Delegating to a Roomote agent…',
          taskUrl: context.taskUrl,
        }),
        unfurl_links: false,
        unfurl_media: false,
      });

      if (!messageTs) {
        return;
      }

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
        `[Fast Agent] Failed to post the Slack task card for run ${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // The generated task title usually lands shortly after enqueue, well
  // before the worker's first event; swap the card's opening
  // (prompt-derived) title for it as soon as it exists. Bounded to the
  // pre-worker window (the worker re-renders with the generated title
  // itself on start).
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

        await slack.updateMessage({
          channel: data.channel,
          ts: data.messageTs,
          message: buildSlackLiveTaskCardBlocks({
            taskUpdateId: data.taskUpdateId,
            title,
            status: 'in_progress',
            step: 'Delegating to a Roomote agent…',
            ...(data.taskUrl ? { taskUrl: data.taskUrl } : {}),
          }),
        });
        await setSlackLiveTaskStreamData(taskId, { ...data, title });
        return;
      }
    } catch (error) {
      console.error(
        `[Fast Agent] Failed to refresh the Slack task card title for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return createFastAgentSlackTaskLauncher({
    ...launcherParams,
    liveTaskStream: true,
    afterKickoff: startLiveTaskCard,
    afterLaunch: refreshLiveTaskCardTitle,
  });
}

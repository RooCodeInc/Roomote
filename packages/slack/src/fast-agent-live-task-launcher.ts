import {
  createFastAgentSlackTaskLauncher,
  type FastAgentSlackTaskLauncherParams,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { buildSlackLiveTaskCardBlocks } from './live-task-card-blocks';
import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData,
} from './live-task-stream';
import type { SlackNotifier } from './slack-notifier';

type SlackLiveTaskCardNotifier = Pick<
  SlackNotifier,
  'postMessage' | 'postMessageDetailed'
>;

export const STARTING_TASK_TITLE = 'Starting task…';

/**
 * Fast delegation launcher that also posts a native task card (a
 * `task_card` block) in the parent thread. The card opens as a bare
 * "Starting task…" placeholder; once the sandbox is up the worker renders
 * the generated title and then re-renders the whole card through
 * chat.update for the task's lifetime, so it always shows the latest state.
 */
export function createFastAgentSlackLiveTaskLauncher(
  params: Omit<
    FastAgentSlackTaskLauncherParams,
    'liveTaskStream' | 'afterKickoff' | 'rendersTaskLink'
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

      // The stored title is the prompt-derived fallback the worker renders
      // if no generated title exists yet; the card itself just says the
      // task is starting until the sandbox is up and the worker renders
      // the real title.
      const title = buildSlackLiveTaskTitle(context.prompt);
      const taskUpdateId = `roomote-task-${taskRun.taskId}`;
      const posted = await slack.postMessageDetailed({
        channel: launcherParams.channelId,
        thread_ts: launcherParams.threadTs,
        ...buildSlackLiveTaskCardBlocks({
          taskUpdateId,
          title: STARTING_TASK_TITLE,
          status: 'in_progress',
          taskUrl: context.taskUrl,
        }),
        unfurl_links: false,
        unfurl_media: false,
      });
      const messageTs = posted.ts;

      if (!messageTs) {
        // The kickoff deliberately omits the task link because the card
        // carries it; when the card cannot be posted (for example a Slack
        // app installed before task cards existed rejects the block), post
        // the link on its own so the thread still leads to the task.
        if (!posted.skippedMissingThreadRoot) {
          console.warn(
            `[Fast Agent] Slack rejected the task card for run ${taskRun.id} (${posted.slackErrorCode ?? (posted.transportError ? 'transport error' : 'unknown')}); posting the task link instead.`,
          );
          await slack.postMessage({
            channel: launcherParams.channelId,
            thread_ts: launcherParams.threadTs,
            text: `Open the task: ${context.taskUrl}`,
            blocks: [
              {
                type: 'markdown',
                text: `[Open the task](${context.taskUrl})`,
              },
            ],
            unfurl_links: false,
            unfurl_media: false,
          });
        }
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

  return createFastAgentSlackTaskLauncher({
    ...launcherParams,
    liveTaskStream: true,
    afterKickoff: startLiveTaskCard,
    rendersTaskLink: true,
  });
}

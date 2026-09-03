import {
  clearSlackLiveTaskPendingCleanup,
  compareAndSwapSlackLiveTaskMessageTs,
  getSlackLiveTaskStreamData,
} from './live-task-stream';
import type { SlackNotifier } from './slack-notifier';
import { getSlackThreadActiveTaskIds } from './thread-active-tasks';

type RelocationSlack = Pick<
  SlackNotifier,
  'getRawMessage' | 'postMessage' | 'deleteMessage'
>;

/** Must be called while holding the thread footer lock. */
export async function relocateSlackThreadActiveTaskCards(params: {
  slack: RelocationSlack;
  channel: string;
  threadTs: string;
}): Promise<void> {
  const taskIds = await getSlackThreadActiveTaskIds(params);

  for (const taskId of taskIds) {
    try {
      let data = await getSlackLiveTaskStreamData(taskId);
      if (
        !data ||
        data.channel !== params.channel ||
        data.threadTs !== params.threadTs
      ) {
        continue;
      }

      if (data.pendingOldMessageTs) {
        const oldMessageTs = data.pendingOldMessageTs;
        const cleaned = await params.slack.deleteMessage({
          channel: params.channel,
          ts: oldMessageTs,
        });
        if (cleaned) {
          const cleared = await clearSlackLiveTaskPendingCleanup({
            taskId,
            currentMessageTs: data.messageTs,
            oldMessageTs,
          });
          if (!cleared) continue;
          data = { ...data, pendingOldMessageTs: undefined };
        } else {
          // Keep the single cleanup pointer until this duplicate is gone.
          continue;
        }
      }

      const rawMessage = await params.slack.getRawMessage({
        channel: params.channel,
        threadTs: params.threadTs,
        messageTs: data.messageTs,
      });
      if (!rawMessage) continue;

      const nextMessageTs = await params.slack.postMessage({
        channel: params.channel,
        thread_ts: params.threadTs,
        ...rawMessage,
      });
      if (!nextMessageTs) continue;

      const handedOff = await compareAndSwapSlackLiveTaskMessageTs({
        taskId,
        expectedMessageTs: data.messageTs,
        nextMessageTs,
      });
      if (!handedOff) {
        await params.slack.deleteMessage({
          channel: params.channel,
          ts: nextMessageTs,
        });
        continue;
      }

      const deleted = await params.slack.deleteMessage({
        channel: params.channel,
        ts: data.messageTs,
      });
      if (deleted) {
        const cleared = await clearSlackLiveTaskPendingCleanup({
          taskId,
          currentMessageTs: nextMessageTs,
          oldMessageTs: data.messageTs,
        });
        if (!cleared) {
          console.warn(
            `[slackTaskCardRelocation] Failed to clear completed cleanup for task ${taskId}`,
          );
        }
      }
    } catch (error) {
      console.warn(
        `[slackTaskCardRelocation] Failed to relocate task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

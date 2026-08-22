import { RunStatus } from '@roomote/types';
import { and, db, eq, slackInstallations } from '@roomote/db/server';

import {
  buildSlackLiveTaskCardBlocks,
  SLACK_LIVE_TASK_CARD_MESSAGES,
} from './live-task-card-blocks';
import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
} from './live-task-stream';
import { SlackNotifier } from './slack-notifier';

function payloadUsesLiveTaskStream(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    (payload as { liveTaskStream?: unknown }).liveTaskStream === true
  );
}

/**
 * Settle a task's Slack card from the control plane for terminations no
 * worker observes: a cancel before dequeue, a sandbox that died and was
 * finalized by the reaper, a failed bootstrap. The worker renders the same
 * terminal states itself, so this is idempotent with its `onExit` render.
 *
 * Completed runs are deliberately not handled here: a run only completes
 * through a live worker, which settles the card with the real output.
 */
export async function settleSlackLiveTaskCardForRun(input: {
  taskId: string;
  payload: unknown;
  status: RunStatus.Failed | RunStatus.Canceled;
  taskTitle?: string | null;
}): Promise<void> {
  if (!payloadUsesLiveTaskStream(input.payload)) {
    return;
  }

  try {
    const data = await getSlackLiveTaskStreamData(input.taskId);
    if (!data) {
      return;
    }

    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.isActive, true),
        eq(slackInstallations.teamId, data.teamId),
      ),
      columns: { botAccessToken: true },
    });
    if (!installation?.botAccessToken) {
      return;
    }

    const taskTitle = input.taskTitle?.trim();
    await new SlackNotifier(installation.botAccessToken).updateMessage({
      channel: data.channel,
      ts: data.messageTs,
      message: buildSlackLiveTaskCardBlocks({
        taskUpdateId: data.taskUpdateId,
        title: taskTitle ? buildSlackLiveTaskTitle(taskTitle) : data.title,
        status: 'error',
        message:
          input.status === RunStatus.Canceled
            ? SLACK_LIVE_TASK_CARD_MESSAGES.canceled
            : SLACK_LIVE_TASK_CARD_MESSAGES.failed,
        ...(data.taskUrl ? { taskUrl: data.taskUrl } : {}),
      }),
    });
  } catch (error) {
    console.error(
      `[settleSlackLiveTaskCard] Failed to settle the task card for task ${input.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

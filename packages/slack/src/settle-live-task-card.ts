import { RunStatus } from '@roomote/types';
import { and, db, eq, slackInstallations } from '@roomote/db/server';

import {
  buildSlackLiveTaskCardBlocks,
  SLACK_SESSION_LIVE_TASK_CARD_MESSAGES,
} from './live-task-card-blocks';
import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
} from './live-task-stream';
import { SlackNotifier } from './slack-notifier';
import {
  removeSlackThreadActiveTaskByTaskId,
  type SlackThreadActiveTaskRoute,
} from './thread-active-tasks';
import { withSlackThreadReplyFooterLock } from './thread-reply-footer-ops';

export type SlackLiveTaskCardRenderStatus =
  | 'in_progress'
  | 'complete'
  | 'error';

export interface SlackLiveTaskCardRenderResult {
  /** False when the task has no card (or its workspace is no longer installed). */
  card: boolean;
  /** True when Slack accepted the update. */
  updated: boolean;
}

function payloadUsesLiveTaskStream(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    (payload as { liveTaskStream?: unknown }).liveTaskStream === true
  );
}

/**
 * Re-render a task's Slack card from the control plane. This is the only
 * place the card is ever updated: workers ask for renders through a
 * run-scoped API and never hold the workspace's bot token themselves.
 *
 * The bot token is resolved from the card's own team id, so a render can
 * only ever use the credential of the workspace the card lives in.
 */
export async function renderSlackLiveTaskCard(input: {
  taskId: string;
  status: SlackLiveTaskCardRenderStatus;
  details?: string;
  output?: string;
  /** The task's generated title, rendered in place of the prompt-derived one. */
  taskTitle?: string | null;
}): Promise<SlackLiveTaskCardRenderResult> {
  const terminal = input.status !== 'in_progress';
  let removedRoute: SlackThreadActiveTaskRoute | null = null;
  let data = await getSlackLiveTaskStreamData(input.taskId);
  if (terminal && !data) {
    try {
      removedRoute = await removeSlackThreadActiveTaskByTaskId(input.taskId);
    } catch (error) {
      console.warn(
        `[renderSlackLiveTaskCard] Failed to remove active task ${input.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const taskTitle = input.taskTitle?.trim();
  const route = data ?? removedRoute;
  if (!route) return { card: false, updated: false };
  const installation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(slackInstallations.isActive, true),
      eq(slackInstallations.teamId, route.teamId),
    ),
    columns: { botAccessToken: true },
  });
  if (!installation?.botAccessToken) {
    if (terminal && data) {
      await withSlackThreadReplyFooterLock({
        channel: data.channel,
        threadTs: data.threadTs,
        fn: async () => {
          await removeSlackThreadActiveTaskByTaskId(input.taskId);
        },
      });
    }
    return { card: false, updated: false };
  }

  const slack = new SlackNotifier(installation.botAccessToken);
  if (!data) {
    return { card: false, updated: false };
  }

  return withSlackThreadReplyFooterLock({
    channel: data.channel,
    threadTs: data.threadTs,
    fn: async () => {
      // Relocation swaps messageTs under this same lock. Re-read it only after
      // acquiring the lock so a live render cannot target the deleted copy.
      data = await getSlackLiveTaskStreamData(input.taskId);
      if (!data) {
        if (terminal) {
          await removeSlackThreadActiveTaskByTaskId(input.taskId);
        }
        return { card: false, updated: false };
      }

      let updated = false;
      try {
        updated = await slack.updateMessage({
          channel: data.channel,
          ts: data.messageTs,
          message: buildSlackLiveTaskCardBlocks({
            taskUpdateId: data.taskUpdateId,
            title: taskTitle ? buildSlackLiveTaskTitle(taskTitle) : data.title,
            status: input.status,
            ...(input.details ? { details: input.details } : {}),
            ...(input.output ? { output: input.output } : {}),
            ...(data.taskUrl ? { taskUrl: data.taskUrl } : {}),
          }),
        });
      } finally {
        if (terminal) {
          try {
            await removeSlackThreadActiveTaskByTaskId(input.taskId);
          } catch (error) {
            console.warn(
              `[renderSlackLiveTaskCard] Failed to remove active task ${input.taskId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      return { card: true, updated };
    },
  });
}

/**
 * Settle a task's Slack card for terminations no worker observes: a cancel
 * before dequeue, a sandbox that died and was finalized by the reaper, a
 * failed bootstrap. The worker requests the same terminal render itself on
 * exit, so this is idempotent with it. Never throws.
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
    await renderSlackLiveTaskCard({
      taskId: input.taskId,
      status: 'error',
      output:
        input.status === RunStatus.Canceled
          ? SLACK_SESSION_LIVE_TASK_CARD_MESSAGES.canceled
          : SLACK_SESSION_LIVE_TASK_CARD_MESSAGES.failed,
      taskTitle: input.taskTitle,
    });
  } catch (error) {
    console.error(
      `[settleSlackLiveTaskCard] Failed to settle the task card for task ${input.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

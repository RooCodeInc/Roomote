import { RunStatus } from '@roomote/types';
import { and, db, eq, slackInstallations } from '@roomote/db/server';

import {
  buildSlackLiveTaskCardBlocks,
  SLACK_LIVE_TASK_CARD_MESSAGES,
  SLACK_SESSION_LIVE_TASK_CARD_MESSAGES,
} from './live-task-card-blocks';
import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
} from './live-task-stream';
import { SlackNotifier } from './slack-notifier';

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
  message?: string;
  /** The task's generated title, rendered in place of the prompt-derived one. */
  taskTitle?: string | null;
}): Promise<SlackLiveTaskCardRenderResult> {
  const data = await getSlackLiveTaskStreamData(input.taskId);
  if (!data) {
    return { card: false, updated: false };
  }

  const installation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(slackInstallations.isActive, true),
      eq(slackInstallations.teamId, data.teamId),
    ),
    columns: { botAccessToken: true },
  });
  if (!installation?.botAccessToken) {
    return { card: false, updated: false };
  }

  const taskTitle = input.taskTitle?.trim();
  const updated = await new SlackNotifier(
    installation.botAccessToken,
  ).updateMessage({
    channel: data.channel,
    ts: data.messageTs,
    message: buildSlackLiveTaskCardBlocks({
      taskUpdateId: data.taskUpdateId,
      title: taskTitle ? buildSlackLiveTaskTitle(taskTitle) : data.title,
      status: input.status,
      ...(input.message ? { message: input.message } : {}),
      ...(data.taskUrl ? { taskUrl: data.taskUrl } : {}),
      sessionMode: data.sessionMode === true,
    }),
  });

  return { card: true, updated };
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
      message:
        input.status === RunStatus.Canceled
          ? await dataSessionMessages(input.taskId, 'canceled')
          : await dataSessionMessages(input.taskId, 'failed'),
      taskTitle: input.taskTitle,
    });
  } catch (error) {
    console.error(
      `[settleSlackLiveTaskCard] Failed to settle the task card for task ${input.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function dataSessionMessages(
  taskId: string,
  state: 'canceled' | 'failed',
): Promise<string> {
  const data = await getSlackLiveTaskStreamData(taskId);
  return data?.sessionMode
    ? SLACK_SESSION_LIVE_TASK_CARD_MESSAGES[state]
    : SLACK_LIVE_TASK_CARD_MESSAGES[state];
}

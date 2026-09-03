import type { SlackBlock } from '@roomote/types';
import {
  TASK_RUNTIME_FAILURE_TEXT,
  TASK_STARTUP_FAILURE_TEXT,
  buildOtherRunningTasksText,
  buildTaskStartingText,
} from '@roomote/communication/chat-messages';

interface BuildStartedBlocksOptions {
  workspaceDisplayName: string;
  modelDisplayName?: string;
  kickoffMessage?: string | null;
  runId?: number | null;
  otherRunningTasksCount?: number;
  taskId?: string | null;
  initiatingSlackUserId?: string;
  taskUrl?: string;
  readinessNote?: string;
  warningText?: string;
}

export const SLACK_STARTUP_FAILURE_TEXT = TASK_STARTUP_FAILURE_TEXT;
export const SLACK_RUNTIME_FAILURE_TEXT = TASK_RUNTIME_FAILURE_TEXT;

/**
 * Block Kit blocks shown after a routing confirmation is accepted.
 * Used by both OK-button and auto-confirm paths.
 *
 * When `taskUrl` is provided, a "Follow" button is added alongside Cancel.
 */
export function buildStartedBlocks(
  options: BuildStartedBlocksOptions,
): SlackBlock[] {
  const {
    workspaceDisplayName,
    modelDisplayName,
    kickoffMessage,
    runId,
    otherRunningTasksCount,
    taskId,
    initiatingSlackUserId,
    taskUrl,
    readinessNote,
    warningText,
  } = options;
  const actionElements: Record<string, unknown>[] = [];

  if (taskUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Follow', emoji: false },
      action_id: 'follow_task',
      url: taskUrl,
    });
  }

  if (taskId || runId) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Cancel', emoji: false },
      action_id: 'cancel_task',
      value: JSON.stringify({
        ...(taskId ? { taskId } : { runId }),
        ...(initiatingSlackUserId
          ? { slackUserId: initiatingSlackUserId }
          : {}),
      }),
    });
  }

  const otherRunningTasksText = buildOtherRunningTasksText(
    otherRunningTasksCount,
  );
  const text = buildTaskStartingText({
    workspaceDisplayName,
    modelDisplayName,
    kickoffMessage,
  });
  const blocks: SlackBlock[] = [
    ...(warningText?.trim()
      ? [
          {
            type: 'section' as const,
            text: { type: 'mrkdwn' as const, text: warningText.trim() },
          },
        ]
      : []),
    { type: 'section', text: { type: 'mrkdwn', text } },
  ];

  if (otherRunningTasksText) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${otherRunningTasksText}_` }],
    });
  }

  if (actionElements.length > 0) {
    blocks.push({ type: 'actions', elements: actionElements });
  }

  if (readinessNote?.trim()) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: readinessNote.trim(),
      },
    });
  }

  return blocks;
}

import { convertMarkdownToRichText } from './markdown-rich-text';
import type { SlackTaskStreamStatus } from './slack-notifier';
import { truncateWithEllipsis } from './truncate';

/** Slack rejects oversized blocks outright (the update then fails and the
 * card keeps its previous state), so the output is budgeted here. */
export const SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS = 4000;

/** Terminal messages shared by the worker and the control plane so a card
 * settled from either side reads the same. */
export const SLACK_LIVE_TASK_CARD_MESSAGES = {
  completed: 'Task completed.',
  canceled: 'Task canceled.',
  failed: 'The task stopped because of an error.',
  trackingUnavailable:
    'Live updates are unavailable for this task; open it to follow progress.',
} as const;

export interface SlackLiveTaskCardContent {
  taskUpdateId: string;
  title: string;
  status: SlackTaskStreamStatus;
  /** Latest agent message, or the final result once settled; rendered as
   * the card output. Always the latest one, never accumulated. */
  message?: string;
  taskUrl?: string;
}

/**
 * A native `task_card` block in an ordinary message. Unlike streamed
 * task_update chunks (whose details/output/sources only ever append), the
 * whole block is replaced on every chat.update, so the card shows exactly
 * the latest state.
 *
 * `block_id` is pinned (Slack generates a new one per update otherwise) so
 * the client keeps treating every render as the same block; a changing id
 * remounts the card and snaps it shut on each update.
 *
 * `text` is what Slack shows in notifications and in clients too old to
 * render the block, so it carries the whole card, link included.
 */
export function buildSlackLiveTaskCardBlocks(
  content: SlackLiveTaskCardContent,
): { text: string; blocks: unknown[] } {
  const message = content.message
    ? truncateWithEllipsis(
        content.message,
        SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS,
      )
    : undefined;

  return {
    text: [
      content.title,
      message,
      content.taskUrl ? `<${content.taskUrl}|Open the task>` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
    blocks: [
      {
        type: 'task_card',
        block_id: `${content.taskUpdateId}-card`,
        task_id: content.taskUpdateId,
        title: content.title,
        status: content.status,
        ...(message ? { output: convertMarkdownToRichText(message) } : {}),
        ...(content.taskUrl
          ? {
              sources: [
                { type: 'url', url: content.taskUrl, text: 'View task' },
              ],
            }
          : {}),
      },
    ],
  };
}

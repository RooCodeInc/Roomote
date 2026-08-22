import { convertMarkdownToRichText } from './markdown-rich-text';
import type { SlackTaskStreamStatus } from './slack-notifier';

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
 */
export function buildSlackLiveTaskCardBlocks(
  content: SlackLiveTaskCardContent,
): { text: string; blocks: unknown[] } {
  const message = content.message?.trim();

  return {
    text: content.title,
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

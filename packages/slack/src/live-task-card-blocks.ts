import { convertMarkdownToRichText } from './markdown-rich-text';
import type { SlackTaskStreamStatus } from './slack-notifier';
import { truncateWithEllipsis } from './truncate';

/** Slack rejects oversized blocks outright (the update then fails and the
 * card keeps its previous state), so rich text is budgeted here. */
export const SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS = 4000;

/** Terminal messages shared by the worker and the control plane so a card
 * settled from either side reads the same. */
export const SLACK_SESSION_LIVE_TASK_CARD_MESSAGES = {
  completed: 'Ready.',
  canceled: 'Stopped.',
  failed: 'Stopped because of an error.',
  trackingUnavailable:
    'Live updates are unavailable; open Roomote to follow progress.',
} as const;

export interface SlackLiveTaskCardContent {
  taskUpdateId: string;
  title: string;
  status: SlackTaskStreamStatus;
  /** Latest live agent message. Always the latest one, never accumulated. */
  details?: string;
  /** Final task result once settled. */
  output?: string;
  taskUrl?: string;
}

/**
 * A native `task_card` block in an ordinary message. Slack renders this as
 * the standard collapsible card regardless of whether `details` or `output`
 * is present. The compact timeline treatment belongs to `task_update` chunks
 * sent through chat.startStream with `task_display_mode: "timeline"`; there is
 * no equivalent display selector on chat.postMessage or chat.update.
 *
 * The whole block is replaced on every chat.update, so the card shows exactly
 * the latest state. Keeping an ordinary message also lets Roomote relocate the
 * card and reopen it after an input-waiting run resumes.
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
  const details = content.details
    ? truncateWithEllipsis(
        content.details,
        SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS,
      )
    : undefined;
  const output = content.output
    ? truncateWithEllipsis(
        content.output,
        SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS,
      )
    : undefined;

  return {
    text: [
      content.title,
      output ?? details,
      content.taskUrl ? `<${content.taskUrl}|Open in Roomote>` : undefined,
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
        ...(details ? { details: convertMarkdownToRichText(details) } : {}),
        ...(output ? { output: convertMarkdownToRichText(output) } : {}),
        ...(content.taskUrl
          ? {
              sources: [
                {
                  type: 'url',
                  url: content.taskUrl,
                  text: 'Open in Roomote',
                },
              ],
            }
          : {}),
      },
    ],
  };
}

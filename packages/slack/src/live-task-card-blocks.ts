import type { SlackTaskStreamStatus } from './slack-notifier';

export interface SlackRichTextValue {
  type: 'rich_text';
  elements: Array<{
    type: 'rich_text_section';
    elements: Array<{ type: 'text'; text: string }>;
  }>;
}

/** Wrap plain text as the single rich_text value task_card fields expect;
 * each non-empty line renders as its own section. */
export function buildSlackRichTextValue(text: string): SlackRichTextValue {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);

  return {
    type: 'rich_text',
    elements: (lines.length > 0 ? lines : ['']).map((line) => ({
      type: 'rich_text_section',
      elements: [{ type: 'text', text: line }],
    })),
  };
}

export interface SlackLiveTaskCardContent {
  taskUpdateId: string;
  title: string;
  status: SlackTaskStreamStatus;
  /** Current step (todo) or waiting state; rendered as the card details. */
  step?: string;
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
 */
export function buildSlackLiveTaskCardBlocks(
  content: SlackLiveTaskCardContent,
): { text: string; blocks: unknown[] } {
  const step = content.step?.trim();
  const message = content.message?.trim();

  return {
    text: content.title,
    blocks: [
      {
        type: 'task_card',
        task_id: content.taskUpdateId,
        title: content.title,
        status: content.status,
        ...(step ? { details: buildSlackRichTextValue(step) } : {}),
        ...(message ? { output: buildSlackRichTextValue(message) } : {}),
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

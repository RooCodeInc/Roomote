import type { SlackTaskStreamStatus } from './slack-notifier';

const STATUS_ICONS: Record<SlackTaskStreamStatus, string> = {
  pending: ':hourglass_flowing_sand:',
  in_progress: ':hourglass_flowing_sand:',
  complete: ':white_check_mark:',
  error: ':warning:',
};

/**
 * Plain-message rendering of a live task card, used when the native stream
 * is no longer accepting chunks (expired server-side or stopped) and the
 * message can only be changed through chat.update.
 */
export function buildSlackLiveTaskCardBlocks(params: {
  title: string;
  status: SlackTaskStreamStatus;
  /** Latest progress line or the settled output. */
  message?: string;
  taskUrl?: string;
}): { text: string; blocks: unknown[] } {
  const lines = [`${STATUS_ICONS[params.status]} *${params.title}*`];
  const message = params.message?.trim();
  if (message) {
    lines.push(message);
  }

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];
  if (params.taskUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${params.taskUrl}|View task>` }],
    });
  }

  return { text: params.title, blocks };
}

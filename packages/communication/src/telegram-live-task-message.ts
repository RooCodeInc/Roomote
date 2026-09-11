import { TELEGRAM_MAX_MESSAGE_LENGTH } from './telegram-format';

export type TelegramLiveTaskStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface TelegramLiveTaskMessageContent {
  status: TelegramLiveTaskStatus;
  progress?: string;
  taskUrl?: string;
}

const TELEGRAM_LIVE_TASK_SUMMARY_MAX_LENGTH = 120;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlWithinBudget(text: string, maxLength: number): string {
  let escaped = '';
  for (const character of text) {
    const next = escapeHtml(character);
    if (escaped.length + next.length > maxLength - 1) {
      return `${escaped.trimEnd()}…`;
    }
    escaped += next;
  }
  return escaped;
}

function getStatusText(status: TelegramLiveTaskStatus): string {
  switch (status) {
    case 'running':
      return 'Starting task…';
    case 'waiting':
      return 'Waiting for your input…';
    case 'completed':
      return 'Completed.';
    case 'failed':
      return 'Task failed.';
    case 'stopped':
      return 'Stopped.';
  }
}

function buildRunningContent(progress: string): {
  summary: string;
  details?: string;
} {
  const [firstLine = '', ...remainingLines] = progress.split('\n');
  const normalizedFirstLine = firstLine.replace(/\s+/g, ' ').trim();
  const summary = truncate(
    normalizedFirstLine || progress.replace(/\s+/g, ' ').trim(),
    TELEGRAM_LIVE_TASK_SUMMARY_MAX_LENGTH,
  );
  const remaining = remainingLines.join('\n').trim();
  const details = remaining || (summary !== progress ? progress : undefined);
  return { summary, ...(details ? { details } : {}) };
}

export function buildTelegramLiveTaskMessage(
  content: TelegramLiveTaskMessageContent,
): {
  text: string;
  htmlText: string;
  buttons?: Array<Array<{ text: string; url: string }>>;
} {
  const progress = content.progress?.trim() || getStatusText(content.status);
  const running =
    content.status === 'running' ? buildRunningContent(progress) : null;
  const text = truncate(
    running?.details
      ? `${running.summary}\n\n${running.details}`
      : (running?.summary ?? progress),
    TELEGRAM_MAX_MESSAGE_LENGTH,
  );
  const htmlPrefix = '<blockquote expandable>';
  const htmlSuffix = '</blockquote>';
  const htmlText = running
    ? `${htmlPrefix}${escapeHtmlWithinBudget(
        running.details
          ? `${running.summary}\n\n${running.details}`
          : running.summary,
        TELEGRAM_MAX_MESSAGE_LENGTH - htmlPrefix.length - htmlSuffix.length,
      )}${htmlSuffix}`
    : escapeHtml(progress);

  return {
    text,
    htmlText,
    ...(content.taskUrl
      ? { buttons: [[{ text: 'Open task', url: content.taskUrl }]] }
      : {}),
  };
}

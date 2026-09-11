import { TELEGRAM_MAX_MESSAGE_LENGTH } from './telegram-format';

export type TelegramLiveTaskStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface TelegramLiveTaskMessageContent {
  title: string;
  status: TelegramLiveTaskStatus;
  elapsedSeconds?: number;
  progress?: string;
  taskUrl?: string;
}

const TELEGRAM_LIVE_TASK_TITLE_MAX_LENGTH = 160;
const TELEGRAM_LIVE_TASK_ACTIVITY_MAX_LENGTH = 120;

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

function formatElapsed(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds < 0) return undefined;
  if (seconds < 60) return `${Math.floor(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function statusLabel(status: TelegramLiveTaskStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'waiting':
      return 'Waiting for input';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
  }
}

function statusIcon(status: TelegramLiveTaskStatus): string {
  switch (status) {
    case 'running':
      return '⏳';
    case 'waiting':
      return '⏸️';
    case 'completed':
      return '✅';
    case 'failed':
      return '⚠️';
    case 'stopped':
      return '⏹️';
  }
}

export function buildTelegramLiveTaskMessage(
  content: TelegramLiveTaskMessageContent,
): {
  text: string;
  htmlText: string;
  buttons?: Array<Array<{ text: string; url: string }>>;
} {
  const title = truncate(
    content.title.replace(/\s+/g, ' ').trim(),
    TELEGRAM_LIVE_TASK_TITLE_MAX_LENGTH,
  );
  const elapsed = formatElapsed(content.elapsedSeconds);
  const status = `${statusLabel(content.status)}${elapsed ? ` · ${elapsed}` : ''}`;
  const progress = content.progress?.trim();
  const showExpandedProgress = Boolean(
    progress && content.status === 'running',
  );
  const activity = progress
    ? truncate(
        progress.replace(/\s+/g, ' '),
        TELEGRAM_LIVE_TASK_ACTIVITY_MAX_LENGTH,
      )
    : content.status === 'running'
      ? 'Preparing workspace…'
      : undefined;
  const plainPrefix = [
    `${statusIcon(content.status)} Roomote task`,
    status,
    title,
    ...(activity ? ['', 'Current activity', activity] : []),
  ].join('\n');
  const plainProgress = showExpandedProgress ? `\n\nProgress\n${progress}` : '';
  const text = truncate(
    `${plainPrefix}${plainProgress}`,
    TELEGRAM_MAX_MESSAGE_LENGTH,
  );

  const htmlPrefix = [
    `<b>${statusIcon(content.status)} Roomote task</b>`,
    escapeHtml(status),
    escapeHtml(title),
    ...(activity ? ['', '<b>Current activity</b>', escapeHtml(activity)] : []),
  ].join('\n');
  const htmlProgressPrefix = '\n\n<blockquote expandable><b>Progress</b>\n';
  const htmlProgressSuffix = '</blockquote>';
  const htmlText =
    showExpandedProgress && progress
      ? `${htmlPrefix}${htmlProgressPrefix}${escapeHtmlWithinBudget(
          progress,
          TELEGRAM_MAX_MESSAGE_LENGTH -
            htmlPrefix.length -
            htmlProgressPrefix.length -
            htmlProgressSuffix.length,
        )}${htmlProgressSuffix}`
      : htmlPrefix;

  return {
    text,
    htmlText,
    ...(content.taskUrl
      ? { buttons: [[{ text: 'Open in Roomote', url: content.taskUrl }]] }
      : {}),
  };
}

import { getRedis } from '@roomote/redis';

import { truncateWithEllipsis } from './truncate';

const SLACK_LIVE_TASK_STREAM_TTL_SECONDS = 7 * 24 * 60 * 60;
const SLACK_LIVE_TASK_TITLE_MAX_LENGTH = 160;

export interface SlackLiveTaskStreamData {
  /** Workspace that owns the card; every update must use this team's bot token. */
  teamId: string;
  channel: string;
  messageTs: string;
  taskId: string;
  taskUpdateId: string;
  threadTs: string;
  title: string;
  taskUrl?: string;
  sessionMode?: boolean;
}

// Keyed by task id: runs are replaced on snapshot resume, but the card in the
// Slack thread belongs to the task for its whole lifetime. The record is never
// deleted on settle (a follow-up run re-opens the same card); it expires with
// the TTL.
function getSlackLiveTaskStreamKey(taskId: string): string {
  return `slack:live_task_stream:task:${taskId}`;
}

export function buildSlackLiveTaskTitle(prompt: string): string {
  return truncateWithEllipsis(
    prompt.replace(/\s+/g, ' '),
    SLACK_LIVE_TASK_TITLE_MAX_LENGTH,
  );
}

export async function setSlackLiveTaskStreamData(
  taskId: string,
  data: SlackLiveTaskStreamData,
): Promise<void> {
  await getRedis().set(
    getSlackLiveTaskStreamKey(taskId),
    JSON.stringify(data),
    'EX',
    SLACK_LIVE_TASK_STREAM_TTL_SECONDS,
  );
}

export async function getSlackLiveTaskStreamData(
  taskId: string,
): Promise<SlackLiveTaskStreamData | null> {
  const raw = await getRedis().get(getSlackLiveTaskStreamKey(taskId));

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SlackLiveTaskStreamData>;

    if (
      typeof parsed.teamId !== 'string' ||
      typeof parsed.channel !== 'string' ||
      typeof parsed.messageTs !== 'string' ||
      typeof parsed.taskId !== 'string' ||
      typeof parsed.taskUpdateId !== 'string' ||
      typeof parsed.threadTs !== 'string' ||
      typeof parsed.title !== 'string'
    ) {
      return null;
    }

    return parsed as SlackLiveTaskStreamData;
  } catch {
    return null;
  }
}

import { getRedis } from '@roomote/redis';

import { truncateWithEllipsis } from './truncate';

const SLACK_LIVE_TASK_STREAM_TTL_SECONDS = 7 * 24 * 60 * 60;
const SLACK_LIVE_TASK_TITLE_MAX_LENGTH = 160;
const CAS_SLACK_LIVE_TASK_MESSAGE_TS_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
if data.messageTs ~= ARGV[1] then return 0 end
data.messageTs = ARGV[2]
data.pendingOldMessageTs = ARGV[1]
redis.call('set', KEYS[1], cjson.encode(data), 'KEEPTTL')
return 1
`;
const CLEAR_PENDING_SLACK_LIVE_TASK_CLEANUP_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
if data.messageTs ~= ARGV[1] or data.pendingOldMessageTs ~= ARGV[2] then return 0 end
data.pendingOldMessageTs = nil
redis.call('set', KEYS[1], cjson.encode(data), 'KEEPTTL')
return 1
`;

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
  /** Old canonical copy whose deletion failed after a successful handoff. */
  pendingOldMessageTs?: string;
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

export async function compareAndSwapSlackLiveTaskMessageTs(params: {
  taskId: string;
  expectedMessageTs: string;
  nextMessageTs: string;
}): Promise<boolean> {
  return (
    (await getRedis().eval(
      CAS_SLACK_LIVE_TASK_MESSAGE_TS_SCRIPT,
      1,
      getSlackLiveTaskStreamKey(params.taskId),
      params.expectedMessageTs,
      params.nextMessageTs,
    )) === 1
  );
}

export async function clearSlackLiveTaskPendingCleanup(params: {
  taskId: string;
  currentMessageTs: string;
  oldMessageTs: string;
}): Promise<boolean> {
  return (
    (await getRedis().eval(
      CLEAR_PENDING_SLACK_LIVE_TASK_CLEANUP_SCRIPT,
      1,
      getSlackLiveTaskStreamKey(params.taskId),
      params.currentMessageTs,
      params.oldMessageTs,
    )) === 1
  );
}

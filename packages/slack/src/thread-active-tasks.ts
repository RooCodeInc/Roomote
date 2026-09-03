import crypto from 'node:crypto';

import { getRedis } from '@roomote/redis';

const SLACK_THREAD_ACTIVE_TASKS_TTL_SECONDS = 30 * 24 * 60 * 60;
const REGISTER_SLACK_THREAD_ACTIVE_TASK_SCRIPT = `
local existing = redis.call('get', KEYS[2])
if existing then
  local route = cjson.decode(existing)
  if route.channel == ARGV[2] and route.threadTs == ARGV[3] then
    if not redis.call('zscore', KEYS[1], ARGV[1]) then
      local sequence = redis.call('incr', KEYS[3])
      redis.call('zadd', KEYS[1], sequence, ARGV[1])
    end
    redis.call('expire', KEYS[1], ARGV[5])
    redis.call('expire', KEYS[2], ARGV[5])
    redis.call('expire', KEYS[3], ARGV[5])
    return existing
  end
end
local sequence = redis.call('incr', KEYS[3])
redis.call('zadd', KEYS[1], sequence, ARGV[1])
redis.call('expire', KEYS[1], ARGV[5])
redis.call('expire', KEYS[3], ARGV[5])
redis.call('set', KEYS[2], ARGV[4], 'EX', ARGV[5])
return ARGV[4]
`;
const REMOVE_SLACK_THREAD_ACTIVE_TASK_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('zrem', KEYS[2], ARGV[2])
redis.call('del', KEYS[1])
return 1
`;

export interface SlackThreadActiveTaskRoute {
  teamId: string;
  channel: string;
  threadTs: string;
  version: string;
}

function getSlackThreadActiveTasksKey(
  channel: string,
  threadTs: string,
): string {
  // The prior summary feature used slack:thread_active_tasks as a Redis hash.
  // Keep the canonical-card zset on a new key so rolling deploys never hit a
  // WRONGTYPE error while those old TTL-bound hashes drain.
  return `slack:thread_active_task_cards:${channel}:${threadTs}`;
}

function getSlackThreadActiveTaskSequenceKey(
  channel: string,
  threadTs: string,
): string {
  return `slack:thread_active_task_sequence:${channel}:${threadTs}`;
}

function getSlackThreadActiveTaskKey(taskId: string): string {
  return `slack:thread_active_task:${taskId}`;
}

/** Register a canonical card once, preserving its position across live updates. */
export async function registerSlackThreadActiveTask(params: {
  teamId: string;
  channel: string;
  threadTs: string;
  taskId: string;
}): Promise<SlackThreadActiveTaskRoute> {
  const route = {
    teamId: params.teamId,
    channel: params.channel,
    threadTs: params.threadTs,
    version: crypto.randomUUID(),
  } satisfies SlackThreadActiveTaskRoute;
  const rawRoute = await getRedis().eval(
    REGISTER_SLACK_THREAD_ACTIVE_TASK_SCRIPT,
    3,
    getSlackThreadActiveTasksKey(params.channel, params.threadTs),
    getSlackThreadActiveTaskKey(params.taskId),
    getSlackThreadActiveTaskSequenceKey(params.channel, params.threadTs),
    params.taskId,
    params.channel,
    params.threadTs,
    JSON.stringify(route),
    SLACK_THREAD_ACTIVE_TASKS_TTL_SECONDS.toString(),
  );

  return JSON.parse(String(rawRoute)) as SlackThreadActiveTaskRoute;
}

export async function removeSlackThreadActiveTaskByTaskId(
  taskId: string,
): Promise<SlackThreadActiveTaskRoute | null> {
  const redis = getRedis();
  const taskKey = getSlackThreadActiveTaskKey(taskId);
  const rawRoute = await redis.get(taskKey);
  if (!rawRoute) return null;

  let route: SlackThreadActiveTaskRoute;
  try {
    route = JSON.parse(rawRoute) as SlackThreadActiveTaskRoute;
    if (
      typeof route.teamId !== 'string' ||
      typeof route.channel !== 'string' ||
      typeof route.threadTs !== 'string' ||
      typeof route.version !== 'string'
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const removed = await redis.eval(
    REMOVE_SLACK_THREAD_ACTIVE_TASK_SCRIPT,
    2,
    taskKey,
    getSlackThreadActiveTasksKey(route.channel, route.threadTs),
    rawRoute,
    taskId,
  );
  return removed === 1 ? route : null;
}

export async function getSlackThreadActiveTaskIds(params: {
  channel: string;
  threadTs: string;
}): Promise<string[]> {
  return getRedis().zrange(
    getSlackThreadActiveTasksKey(params.channel, params.threadTs),
    0,
    -1,
  );
}

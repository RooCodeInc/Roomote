import { getRedis } from '@roomote/redis';

const SLACK_THREAD_ACTIVE_TASKS_TTL_SECONDS = 30 * 24 * 60 * 60;
const UPSERT_SLACK_THREAD_ACTIVE_TASK_SCRIPT = `
redis.call('hset', KEYS[1], ARGV[1], ARGV[2])
redis.call('expire', KEYS[1], ARGV[3])
return 1
`;

export const SLACK_THREAD_ACTIVE_TASK_BLOCK_ID_PREFIX =
  'roomote_thread_active_task_';

export interface SlackThreadActiveTask {
  taskId: string;
  title: string;
  taskUrl?: string;
  updatedAt: number;
}

function getSlackThreadActiveTasksKey(
  channel: string,
  threadTs: string,
): string {
  return `slack:thread_active_tasks:${channel}:${threadTs}`;
}

export async function setSlackThreadActiveTask(params: {
  channel: string;
  threadTs: string;
  task: Omit<SlackThreadActiveTask, 'updatedAt'>;
}): Promise<void> {
  const redis = getRedis();
  const key = getSlackThreadActiveTasksKey(params.channel, params.threadTs);
  await redis.eval(
    UPSERT_SLACK_THREAD_ACTIVE_TASK_SCRIPT,
    1,
    key,
    params.task.taskId,
    JSON.stringify({ ...params.task, updatedAt: Date.now() }),
    SLACK_THREAD_ACTIVE_TASKS_TTL_SECONDS.toString(),
  );
}

export async function removeSlackThreadActiveTask(params: {
  channel: string;
  threadTs: string;
  taskId: string;
}): Promise<void> {
  await getRedis().hdel(
    getSlackThreadActiveTasksKey(params.channel, params.threadTs),
    params.taskId,
  );
}

export async function getSlackThreadActiveTasks(params: {
  channel: string;
  threadTs: string;
}): Promise<SlackThreadActiveTask[]> {
  const values = await getRedis().hgetall(
    getSlackThreadActiveTasksKey(params.channel, params.threadTs),
  );

  return Object.values(values).flatMap((value) => {
    try {
      const task = JSON.parse(value) as Partial<SlackThreadActiveTask>;
      return typeof task.taskId === 'string' &&
        typeof task.title === 'string' &&
        typeof task.updatedAt === 'number' &&
        (task.taskUrl === undefined || typeof task.taskUrl === 'string')
        ? [task as SlackThreadActiveTask]
        : [];
    } catch {
      return [];
    }
  });
}

export function isSlackThreadActiveTaskBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const blockId = (block as { block_id?: unknown }).block_id;
  return (
    typeof blockId === 'string' &&
    blockId.startsWith(SLACK_THREAD_ACTIVE_TASK_BLOCK_ID_PREFIX)
  );
}

export function buildSlackThreadActiveTaskBlocks(
  tasks: SlackThreadActiveTask[],
): unknown[] {
  if (tasks.length === 0) return [];

  const escapeTitle = (title: string) =>
    title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkedTitle = (task: SlackThreadActiveTask) => {
    const title = escapeTitle(task.title);
    return task.taskUrl ? `<${task.taskUrl}|${title}>` : title;
  };
  const ordered = [...tasks].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId),
  );
  const lines = ordered.map(
    (task) => `:large_blue_circle: *${linkedTitle(task)}*`,
  );
  let omitted = 0;
  const maxChars = 2900;
  const render = () =>
    [
      ...lines,
      ...(omitted > 0
        ? [
            `_${omitted} additional active task${omitted === 1 ? '' : 's'} not shown_`,
          ]
        : []),
    ].join('\n');
  while (lines.length > 0 && render().length > maxChars) {
    lines.pop();
    omitted += 1;
  }

  return [
    {
      type: 'section',
      block_id: `${SLACK_THREAD_ACTIVE_TASK_BLOCK_ID_PREFIX}list`,
      text: { type: 'mrkdwn', text: render() },
    },
  ];
}

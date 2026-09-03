import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  get: vi.fn(),
  zrange: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({ getRedis: () => mocks }));
vi.mock('node:crypto', () => ({
  default: { randomUUID: () => 'route-version' },
}));

import {
  getSlackThreadActiveTaskIds,
  registerSlackThreadActiveTask,
  removeSlackThreadActiveTaskByTaskId,
} from '../thread-active-tasks';

describe('thread-active-tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(null);
    mocks.zrange.mockResolvedValue([]);
  });

  it('registers a canonical card in a stable sequenced zset', async () => {
    const route = {
      teamId: 'T1',
      channel: 'C1',
      threadTs: '100.000',
      version: 'route-version',
    };
    mocks.eval.mockResolvedValue(JSON.stringify(route));

    await expect(
      registerSlackThreadActiveTask({ ...route, taskId: 'task-1' }),
    ).resolves.toEqual(route);

    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('zadd'"),
      3,
      'slack:thread_active_task_cards:C1:100.000',
      'slack:thread_active_task:task-1',
      'slack:thread_active_task_sequence:C1:100.000',
      'task-1',
      'C1',
      '100.000',
      JSON.stringify(route),
      (30 * 24 * 60 * 60).toString(),
    );
  });

  it('returns task ids in their stable Redis score order', async () => {
    mocks.zrange.mockResolvedValue(['task-1', 'task-2', 'task-3']);

    await expect(
      getSlackThreadActiveTaskIds({ channel: 'C1', threadTs: '100.000' }),
    ).resolves.toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('removes a terminal task through its versioned task route', async () => {
    const route = {
      teamId: 'T1',
      channel: 'C1',
      threadTs: '100.000',
      version: 'route-version',
    };
    mocks.get.mockResolvedValue(JSON.stringify(route));
    mocks.eval.mockResolvedValue(1);

    await expect(
      removeSlackThreadActiveTaskByTaskId('task-1'),
    ).resolves.toEqual(route);
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('zrem'"),
      2,
      'slack:thread_active_task:task-1',
      'slack:thread_active_task_cards:C1:100.000',
      JSON.stringify(route),
      'task-1',
    );
  });

  it('does not remove a task whose route changed during settlement', async () => {
    mocks.get.mockResolvedValue(
      JSON.stringify({
        teamId: 'T1',
        channel: 'C1',
        threadTs: '100.000',
        version: 'older-version',
      }),
    );
    mocks.eval.mockResolvedValue(0);

    await expect(
      removeSlackThreadActiveTaskByTaskId('task-1'),
    ).resolves.toBeNull();
  });
});

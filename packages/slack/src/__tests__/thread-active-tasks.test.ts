import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  get: vi.fn(),
  hgetall: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => mocks,
}));

vi.mock('node:crypto', () => ({
  default: { randomUUID: () => 'route-version' },
}));

import {
  getSlackThreadActiveTasks,
  removeSlackThreadActiveTaskByTaskId,
  setSlackThreadActiveTask,
} from '../thread-active-tasks';

describe('thread-active-tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.eval.mockResolvedValue(1);
    mocks.get.mockResolvedValue(null);
    mocks.hgetall.mockResolvedValue({});
  });

  it('persists one active task per Slack thread', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));

    await setSlackThreadActiveTask({
      teamId: 'T1',
      channel: 'C1',
      threadTs: '100.000',
      task: {
        taskId: 'task-1',
        title: 'Ship the change',
        taskUrl: 'https://app.example.com/task/task-1',
      },
    });

    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('hset'"),
      2,
      'slack:thread_active_tasks:C1:100.000',
      'slack:thread_active_task:task-1',
      'task-1',
      JSON.stringify({
        taskId: 'task-1',
        title: 'Ship the change',
        taskUrl: 'https://app.example.com/task/task-1',
        updatedAt: Date.now(),
      }),
      JSON.stringify({
        teamId: 'T1',
        channel: 'C1',
        threadTs: '100.000',
        version: 'route-version',
      }),
      (30 * 24 * 60 * 60).toString(),
    );
  });

  it('removes a terminal task through its task-scoped thread pointer', async () => {
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
      expect.stringContaining("redis.call('hdel'"),
      2,
      'slack:thread_active_task:task-1',
      'slack:thread_active_tasks:C1:100.000',
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

  it('ignores malformed persisted summaries', async () => {
    mocks.hgetall.mockResolvedValue({
      valid: JSON.stringify({
        taskId: 'task-1',
        title: 'Valid task',
        updatedAt: 1,
      }),
      badJson: '{',
      badRecord: JSON.stringify({
        taskId: 'task-2',
        updatedAt: 2,
      }),
    });

    await expect(
      getSlackThreadActiveTasks({
        channel: 'C1',
        threadTs: '100.000',
      }),
    ).resolves.toEqual([
      {
        taskId: 'task-1',
        title: 'Valid task',
        updatedAt: 1,
      },
    ]);
  });
});

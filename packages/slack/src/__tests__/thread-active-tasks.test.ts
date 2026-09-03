import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  hdel: vi.fn(),
  hgetall: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => mocks,
}));

import {
  getSlackThreadActiveTasks,
  removeSlackThreadActiveTask,
  setSlackThreadActiveTask,
} from '../thread-active-tasks';

describe('thread-active-tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.eval.mockResolvedValue(1);
    mocks.hdel.mockResolvedValue(1);
    mocks.hgetall.mockResolvedValue({});
  });

  it('persists one active task per Slack thread', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));

    await setSlackThreadActiveTask({
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
      1,
      'slack:thread_active_tasks:C1:100.000',
      'task-1',
      JSON.stringify({
        taskId: 'task-1',
        title: 'Ship the change',
        taskUrl: 'https://app.example.com/task/task-1',
        updatedAt: Date.now(),
      }),
      (30 * 24 * 60 * 60).toString(),
    );
  });

  it('removes a task as soon as it becomes terminal', async () => {
    await removeSlackThreadActiveTask({
      channel: 'C1',
      threadTs: '100.000',
      taskId: 'task-1',
    });

    expect(mocks.hdel).toHaveBeenCalledWith(
      'slack:thread_active_tasks:C1:100.000',
      'task-1',
    );
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

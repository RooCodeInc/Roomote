import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  eval: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({ getRedis: () => redis }));

import {
  clearSlackLiveTaskPendingCleanup,
  compareAndSwapSlackLiveTaskMessageTs,
} from '../live-task-stream';

describe('live-task-stream atomic relocation state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.eval.mockResolvedValue(1);
  });

  it('atomically swaps only the expected canonical message timestamp', async () => {
    await expect(
      compareAndSwapSlackLiveTaskMessageTs({
        taskId: 'task-1',
        expectedMessageTs: 'old-ts',
        nextMessageTs: 'new-ts',
      }),
    ).resolves.toBe(true);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('data.pendingOldMessageTs = ARGV[1]'),
      1,
      'slack:live_task_stream:task:task-1',
      'old-ts',
      'new-ts',
    );
  });

  it('clears pending cleanup only against the current pointer', async () => {
    await expect(
      clearSlackLiveTaskPendingCleanup({
        taskId: 'task-1',
        currentMessageTs: 'new-ts',
        oldMessageTs: 'old-ts',
      }),
    ).resolves.toBe(true);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('data.pendingOldMessageTs = nil'),
      1,
      'slack:live_task_stream:task:task-1',
      'new-ts',
      'old-ts',
    );
  });

  it('reports a lost compare-and-swap race', async () => {
    redis.eval.mockResolvedValue(0);
    await expect(
      compareAndSwapSlackLiveTaskMessageTs({
        taskId: 'task-1',
        expectedMessageTs: 'stale-ts',
        nextMessageTs: 'new-ts',
      }),
    ).resolves.toBe(false);
  });
});

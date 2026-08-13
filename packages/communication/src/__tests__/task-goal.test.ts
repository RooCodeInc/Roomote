import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  prepareTaskGoalActivation: mocks.prepare,
}));

import { parseGoalCommand } from '../task-goal-command';
import { activateTaskGoal } from '../task-goal';

describe('task goal communication helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockResolvedValue({
      generation: 'goal-generation:test',
      commit: mocks.commit,
      rollback: mocks.rollback,
    });
    mocks.commit.mockResolvedValue({
      objective: 'ship the release',
      maxContinuations: 5,
      generation: 'goal-generation:test',
      status: 'active',
      continuationsUsed: 0,
      blockedReason: null,
      completedAt: null,
    });
    mocks.rollback.mockResolvedValue(true);
  });

  it('parses only complete goal commands', () => {
    expect(parseGoalCommand('/goal ship the release')).toEqual({
      objective: 'ship the release',
    });
    expect(parseGoalCommand('please /goal ship')).toBeNull();
  });

  it('commits only after delivery accepts the trusted goal context', async () => {
    const deliver = vi.fn().mockResolvedValue(true);

    await expect(
      activateTaskGoal({
        taskId: 'task-1',
        objective: 'ship the release',
        deliver,
      }),
    ).resolves.toMatchObject({ success: true });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: 'ship the release',
        generation: 'goal-generation:test',
      }),
    );
    expect(mocks.commit).toHaveBeenCalledAfter(deliver);
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('rolls back when delivery rejects the goal turn', async () => {
    await expect(
      activateTaskGoal({
        taskId: 'task-1',
        objective: 'ship the release',
        deliver: async () => false,
      }),
    ).resolves.toEqual({ success: false, error: 'delivery_rejected' });

    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});

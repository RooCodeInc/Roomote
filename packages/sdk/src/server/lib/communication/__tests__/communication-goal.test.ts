import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareTaskGoalActivation, commit, rollback } = vi.hoisted(() => ({
  prepareTaskGoalActivation: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({ prepareTaskGoalActivation }));

import { activateCommunicationGoal } from '../communication-goal';

describe('activateCommunicationGoal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rollback.mockResolvedValue(true);
    commit.mockResolvedValue({
      objective: 'ship the release',
      generation: 'goal-generation:1',
      status: 'active',
      maxContinuations: 5,
      continuationsUsed: 0,
      blockedReason: null,
      completedAt: null,
    });
    prepareTaskGoalActivation.mockResolvedValue({
      generation: 'goal-generation:1',
      commit,
      rollback,
    });
  });

  it('delivers trusted context before committing activation', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    await expect(
      activateCommunicationGoal({
        taskId: 'task-1',
        goal: { objective: 'ship the release', maxContinuations: 5 },
        deliver,
      }),
    ).resolves.toMatchObject({ success: true });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 'goal-generation:1' }),
    );
    expect(deliver.mock.invocationCallOrder[0]).toBeLessThan(
      commit.mock.invocationCallOrder[0]!,
    );
  });

  it('rolls back when durable delivery fails', async () => {
    const error = new Error('queue unavailable');
    await expect(
      activateCommunicationGoal({
        taskId: 'task-1',
        goal: { objective: 'ship the release', maxContinuations: 5 },
        deliver: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toBe(error);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });
});

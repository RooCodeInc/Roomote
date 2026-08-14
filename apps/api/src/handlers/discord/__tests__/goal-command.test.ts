const mocks = vi.hoisted(() => ({
  prepareActivation: vi.fn(),
  sendMessage: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  prepareTaskGoalActivation: mocks.prepareActivation,
}));

vi.mock('../../tasks/sendMessageToTask.js', () => ({
  sendMessageToTask: mocks.sendMessage,
}));

import { startDiscordTaskGoal } from '../goal-command.js';

describe('startDiscordTaskGoal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareActivation.mockResolvedValue({
      generation: 'goal-generation:1',
      commit: mocks.commit,
      rollback: mocks.rollback,
    });
    mocks.sendMessage.mockResolvedValue({ success: true, result: {} });
    mocks.commit.mockResolvedValue({ objective: 'Ship the release' });
    mocks.rollback.mockResolvedValue(true);
  });

  it('delivers the objective with trusted Goal Mode context before committing', async () => {
    await expect(
      startDiscordTaskGoal({
        taskId: 'task-1',
        userId: 'user-1',
        objective: 'Ship the release',
        clientMessageId: 'interaction-1',
      }),
    ).resolves.toEqual({ success: true });

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      taskId: 'task-1',
      userId: 'user-1',
      message: 'Ship the release',
      source: 'discord',
      clientMessageId: 'interaction-1',
      goalContext: expect.objectContaining({
        objective: 'Ship the release',
        generation: 'goal-generation:1',
        status: 'active',
      }),
    });
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('rolls back activation when prompt delivery fails', async () => {
    mocks.sendMessage.mockResolvedValue({
      success: false,
      error: 'Task has no active sandbox.',
      status: 409,
    });

    await expect(
      startDiscordTaskGoal({
        taskId: 'task-1',
        userId: 'user-1',
        objective: 'Ship the release',
        clientMessageId: 'interaction-1',
      }),
    ).resolves.toEqual({
      success: false,
      error: 'Task has no active sandbox.',
    });

    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('rolls back activation when commit fails', async () => {
    mocks.commit.mockRejectedValue(new Error('database unavailable'));

    await expect(
      startDiscordTaskGoal({
        taskId: 'task-1',
        userId: 'user-1',
        objective: 'Ship the release',
        clientMessageId: 'interaction-1',
      }),
    ).rejects.toThrow('database unavailable');

    expect(mocks.rollback).toHaveBeenCalledOnce();
  });
});

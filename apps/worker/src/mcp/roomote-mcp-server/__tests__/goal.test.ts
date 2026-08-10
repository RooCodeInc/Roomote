const { getGoal, markGoalComplete, markGoalBlocked } = vi.hoisted(() => ({
  getGoal: vi.fn(),
  markGoalComplete: vi.fn(),
  markGoalBlocked: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: { getGoal, markGoalComplete, markGoalBlocked },
  },
}));

import { handleManageGoal } from '../goal';

describe('manage goal tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROOMOTE_TASK_RUN_ID = '42';
  });

  afterEach(() => {
    delete process.env.ROOMOTE_TASK_RUN_ID;
  });

  it('reads the current run goal', async () => {
    getGoal.mockResolvedValue({
      objective: 'Finish the task',
      status: 'active',
    });

    await handleManageGoal({ action: 'get' });

    expect(getGoal).toHaveBeenCalledWith({ runId: 42 });
  });

  it('marks the current run goal complete', async () => {
    markGoalComplete.mockResolvedValue({ updated: true });

    await handleManageGoal({ action: 'complete' });

    expect(markGoalComplete).toHaveBeenCalledWith({ runId: 42 });
  });

  it('requires and forwards a blocked reason', async () => {
    const missingReason = await handleManageGoal({ action: 'blocked' });
    markGoalBlocked.mockResolvedValue({ updated: true });
    await handleManageGoal({ action: 'blocked', reason: 'Needs user input' });

    expect(missingReason.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('reason is required'),
    });
    expect(markGoalBlocked).toHaveBeenCalledWith({
      runId: 42,
      reason: 'Needs user input',
    });
  });
});

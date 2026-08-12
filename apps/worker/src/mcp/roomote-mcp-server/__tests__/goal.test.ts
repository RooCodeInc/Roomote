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
      generation: 'goal-generation:current',
      status: 'active',
    });

    const result = await handleManageGoal({ action: 'get' });

    expect(getGoal).toHaveBeenCalledWith({ runId: 42 });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.not.stringContaining('goal-generation:current'),
    });
  });

  it('marks the current run goal complete', async () => {
    markGoalComplete.mockResolvedValue({ updated: true });

    await handleManageGoal({
      action: 'complete',
      generation: 'goal-generation:current',
    });

    expect(markGoalComplete).toHaveBeenCalledWith({
      runId: 42,
      generation: 'goal-generation:current',
    });
  });

  it('requires and forwards a blocked reason', async () => {
    const missingReason = await handleManageGoal({ action: 'blocked' });
    markGoalBlocked.mockResolvedValue({ updated: true });
    await handleManageGoal({
      action: 'blocked',
      generation: 'goal-generation:current',
      reason: 'Needs user input',
    });

    expect(missingReason.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('reason is required'),
    });
    expect(markGoalBlocked).toHaveBeenCalledWith({
      runId: 42,
      generation: 'goal-generation:current',
      reason: 'Needs user input',
    });
  });

  it('requires the turn generation for terminal mutations', async () => {
    const result = await handleManageGoal({ action: 'complete' });

    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('generation is required'),
    });
    expect(markGoalComplete).not.toHaveBeenCalled();
  });
});

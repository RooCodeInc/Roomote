const { getTaskGoal, updateTaskGoal } = vi.hoisted(() => ({
  getTaskGoal: vi.fn(),
  updateTaskGoal: vi.fn(),
}));

vi.mock('../tasks-api-client', () => ({
  getTaskGoal,
  updateTaskGoal,
}));

import { handleManageGoal } from '../goal';

const originalEnv = { ...process.env };
describe('manage goal tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROOMOTE_TASK_RUN_ID = '42';
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';
    process.env.ROOMOTE_PLATFORM_API_URL = 'https://platform.example.com';
    delete process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
    delete process.env.ROOMOTE_AUTH_BYPASS_VALUE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses the MCP platform configuration', async () => {
    getTaskGoal.mockResolvedValue({ goal: null });

    await handleManageGoal({ action: 'get' });

    expect(getTaskGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      }),
      42,
    );
  });

  it('forwards the configured auth bypass header', async () => {
    process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME = 'x-custom-bypass';
    process.env.ROOMOTE_AUTH_BYPASS_VALUE = 'bypass-token';
    getTaskGoal.mockResolvedValue({ goal: null });

    await handleManageGoal({ action: 'get' });

    expect(getTaskGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        authBypassHeaderName: 'x-custom-bypass',
        authBypassHeaderValue: 'bypass-token',
      }),
      42,
    );
  });

  it('reads the current run goal', async () => {
    getTaskGoal.mockResolvedValue({
      goal: {
        objective: 'Finish the task',
        generation: 'goal-generation:current',
        status: 'active',
      },
    });

    const result = await handleManageGoal({ action: 'get' });

    expect(getTaskGoal).toHaveBeenCalledWith(expect.any(Object), 42);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.not.stringContaining('goal-generation:current'),
    });
  });

  it('marks the current run goal complete', async () => {
    updateTaskGoal.mockResolvedValue({ updated: true });

    await handleManageGoal({
      action: 'complete',
      generation: 'goal-generation:current',
    });

    expect(updateTaskGoal).toHaveBeenCalledWith(expect.any(Object), 42, {
      action: 'complete',
      generation: 'goal-generation:current',
    });
  });

  it('requires and forwards a blocked reason', async () => {
    const missingReason = await handleManageGoal({ action: 'blocked' });
    updateTaskGoal.mockResolvedValue({ updated: true });
    await handleManageGoal({
      action: 'blocked',
      generation: 'goal-generation:current',
      reason: 'Needs user input',
    });

    expect(missingReason.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('reason is required'),
    });
    expect(updateTaskGoal).toHaveBeenCalledWith(expect.any(Object), 42, {
      action: 'blocked',
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
    expect(updateTaskGoal).not.toHaveBeenCalled();
  });
});

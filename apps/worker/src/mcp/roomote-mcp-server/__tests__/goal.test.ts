const { createWorkerClient, getGoal, markGoalComplete, markGoalBlocked } =
  vi.hoisted(() => ({
    createWorkerClient: vi.fn(),
    getGoal: vi.fn(),
    markGoalComplete: vi.fn(),
    markGoalBlocked: vi.fn(),
  }));

vi.mock('@roomote/sdk/client', () => ({
  createWorkerClient,
}));

import { handleManageGoal } from '../goal';

const originalEnv = { ...process.env };
const taskRuns = {
  getGoal: { query: getGoal },
  markGoalComplete: { mutate: markGoalComplete },
  markGoalBlocked: { mutate: markGoalBlocked },
};

describe('manage goal tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createWorkerClient.mockReturnValue({ taskRuns });
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
    getGoal.mockResolvedValue(null);

    await handleManageGoal({ action: 'get' });

    expect(createWorkerClient).toHaveBeenCalledWith({
      url: 'https://platform.example.com',
      headers: expect.any(Function),
    });
    const headers = createWorkerClient.mock.calls[0]?.[0].headers();
    expect(headers).toEqual({ Authorization: 'Bearer run-token' });
  });

  it('forwards the configured auth bypass header', async () => {
    process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME = 'x-custom-bypass';
    process.env.ROOMOTE_AUTH_BYPASS_VALUE = 'bypass-token';
    getGoal.mockResolvedValue(null);

    await handleManageGoal({ action: 'get' });

    const headers = createWorkerClient.mock.calls[0]?.[0].headers();
    expect(headers).toEqual({
      Authorization: 'Bearer run-token',
      'x-custom-bypass': 'bypass-token',
    });
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

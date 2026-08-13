import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const { getTaskGoalForRun, markTaskGoalForRun } = vi.hoisted(() => ({
  getTaskGoalForRun: vi.fn(),
  markTaskGoalForRun: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  getTaskGoalForRun,
  markTaskGoalForRun,
}));

import { getGoal, manageGoal } from '../manageGoal';

function createApp(runId = 42) {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', {
      userId: undefined,
      authContext: { runId } as never,
    });
    await next();
  });
  app.get('/runs/:runId/goal', getGoal);
  app.post('/runs/:runId/goal', manageGoal);
  return app;
}

describe('manage goal API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the goal for the token-scoped run', async () => {
    getTaskGoalForRun.mockResolvedValue({
      objective: 'Ship it',
      completedAt: new Date('2026-08-13T15:00:00.000Z'),
    });

    const response = await createApp().request('/runs/42/goal');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      goal: {
        objective: 'Ship it',
        completedAt: '2026-08-13T15:00:00.000Z',
      },
    });
    expect(getTaskGoalForRun).toHaveBeenCalledWith(42);
  });

  it('rejects access to a different run', async () => {
    const response = await createApp().request('/runs/7/goal');

    expect(response.status).toBe(403);
    expect(getTaskGoalForRun).not.toHaveBeenCalled();
  });

  it('forwards complete and blocked mutations', async () => {
    markTaskGoalForRun.mockResolvedValue({ updated: true, goal: {} });
    const app = createApp();

    await app.request('/runs/42/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'complete',
        generation: 'goal-generation:current',
      }),
    });
    await app.request('/runs/42/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'blocked',
        generation: 'goal-generation:current',
        reason: 'Needs input',
      }),
    });

    expect(markTaskGoalForRun).toHaveBeenNthCalledWith(1, {
      runId: 42,
      generation: 'goal-generation:current',
      status: 'complete',
    });
    expect(markTaskGoalForRun).toHaveBeenNthCalledWith(2, {
      runId: 42,
      generation: 'goal-generation:current',
      status: 'blocked',
      reason: 'Needs input',
    });
  });
});

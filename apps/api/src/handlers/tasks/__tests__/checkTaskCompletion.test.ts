import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const mocks = vi.hoisted(() => ({
  evaluateTaskCompletionGate: vi.fn(),
  findTaskRun: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  evaluateTaskCompletionGate: mocks.evaluateTaskCompletionGate,
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mocks.findTaskRun } } },
  eq: vi.fn(),
  taskRuns: {},
}));

import { checkTaskCompletion } from '../checkTaskCompletion';

const check = {
  report: 'Removed the guard.',
  diffStat: ' src/guard.ts | 40 ----',
  diff: 'diff --git a/src/guard.ts b/src/guard.ts\n-guard\n',
  diffTruncated: false,
};

function post(body: unknown, authContext: unknown = { runId: 42 }) {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', {
      userId: undefined,
      authContext: authContext as never,
    });
    await next();
  });
  app.post('/tasks/runs/:runId/completion_check', checkTaskCompletion);

  return app.request('/tasks/runs/42/completion_check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('checkTaskCompletion', () => {
  beforeEach(() => {
    mocks.findTaskRun
      .mockReset()
      .mockResolvedValue({ taskId: 'task-1', actingUserId: 'user-1' });
    mocks.evaluateTaskCompletionGate
      .mockReset()
      .mockResolvedValue({ status: 'clear', flags: [] });
  });

  it("evaluates the run's own task with the submitted diff", async () => {
    const response = await post(check);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'clear',
      flags: [],
    });
    expect(mocks.evaluateTaskCompletionGate).toHaveBeenCalledWith({
      taskId: 'task-1',
      userId: 'user-1',
      // An older worker sends no command evidence.
      check: { ...check, commands: [], trigger: 'turn_end' },
    });
  });

  it('rejects callers without a matching run token', async () => {
    expect((await post(check, { userId: 'user-1' })).status).toBe(403);
    expect((await post(check, { runId: 7 })).status).toBe(403);
    expect(mocks.evaluateTaskCompletionGate).not.toHaveBeenCalled();
  });

  it('rejects an empty or oversized diff', async () => {
    expect((await post({ ...check, diff: '' })).status).toBe(400);
    expect((await post({ ...check, diff: 'x'.repeat(48_001) })).status).toBe(
      400,
    );
  });
});

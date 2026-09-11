import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  recordResult: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
  eq: vi.fn((...args: unknown[]) => args),
  taskRuns: { id: 'task_runs.id' },
  recordAutomationResultForTask: mocks.recordResult,
}));

import { recordAutomationResult } from '../recordAutomationResult';

function createApp(runId: number) {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', {
      authContext: {
        runId,
        userId: 'user-1',
        principal: 'user',
        tokenType: 'run',
        version: 1,
      },
      userId: 'user-1',
    } as McpAuth);
    await next();
  });
  app.post('/tasks/:taskId/automation_result', recordAutomationResult);
  return app;
}

function postResult(app: ReturnType<typeof createApp>, taskId: string) {
  return app.request(`/tasks/${taskId}/automation_result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Result body', dedupeKey: 'result-1' }),
  });
}

describe('recordAutomationResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordResult.mockResolvedValue({ id: 'result-1' });
  });

  it('records a result when the run token belongs to the requested task', async () => {
    mocks.findRun.mockResolvedValue({ taskId: 'task-1' });

    const response = await postResult(createApp(42), 'task-1');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ recorded: true });
    expect(mocks.recordResult).toHaveBeenCalledWith({
      taskId: 'task-1',
      content: 'Result body',
      dedupeKey: 'result-1',
    });
  });

  it('rejects a run token bound to another task', async () => {
    mocks.findRun.mockResolvedValue({ taskId: 'task-2' });

    const response = await postResult(createApp(42), 'task-1');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Task access denied',
    });
    expect(mocks.recordResult).not.toHaveBeenCalled();
  });
});

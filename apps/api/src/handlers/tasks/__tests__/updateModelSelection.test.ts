import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const {
  mockApplyTaskModelSelectionToRun,
  mockFindLatestTaskRun,
  mockTokenRunFindFirst,
} = vi.hoisted(() => ({
  mockApplyTaskModelSelectionToRun: vi.fn(),
  mockFindLatestTaskRun: vi.fn(),
  mockTokenRunFindFirst: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  TaskModelSelectionError: class TaskModelSelectionError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
    }
  },
  applyTaskModelSelectionToRun: mockApplyTaskModelSelectionToRun,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: mockTokenRunFindFirst,
      },
    },
  },
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  taskRuns: { id: 'task_runs.id' },
}));

vi.mock('@roomote/sdk/server', () => ({
  withSandboxServerRpcClient: vi.fn(),
}));

vi.mock('../helpers', () => ({
  findLatestTaskRun: mockFindLatestTaskRun,
}));

import { updateTaskModelSelection } from '../updateModelSelection';

function createApp(auth: McpAuth) {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();

  app.use('*', async (c, next) => {
    c.set('mcpAuth', auth);
    await next();
  });
  app.post('/tasks/:taskId/model_selection', updateTaskModelSelection);
  return app;
}

function postModelSelection(app: Hono<never>, taskId: string) {
  return app.request(`/tasks/${taskId}/model_selection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role: 'coding',
      model: null,
      reasoningEffort: null,
    }),
  });
}

describe('updateTaskModelSelection', () => {
  beforeEach(() => {
    mockApplyTaskModelSelectionToRun.mockReset();
    mockApplyTaskModelSelectionToRun.mockResolvedValue({
      stampedTaskModel: null,
    });
    mockFindLatestTaskRun.mockReset();
    mockFindLatestTaskRun.mockResolvedValue({
      id: 42,
      status: 'completed',
      sandboxServerUrl: null,
      actingUserId: null,
    });
    mockTokenRunFindFirst.mockReset();
  });

  it('rejects a run token bound to a different task without applying', async () => {
    mockTokenRunFindFirst.mockResolvedValue({ taskId: 'other-task' });
    const app = createApp({
      userId: undefined,
      authContext: { runId: 7 } as never,
    });

    const response = await postModelSelection(app as never, 'target-task');

    expect(response.status).toBe(403);
    expect(mockApplyTaskModelSelectionToRun).not.toHaveBeenCalled();
  });

  it('rejects when the run token target no longer exists', async () => {
    mockTokenRunFindFirst.mockResolvedValue(undefined);
    const app = createApp({
      userId: undefined,
      authContext: { runId: 7 } as never,
    });

    const response = await postModelSelection(app as never, 'target-task');

    expect(response.status).toBe(404);
    expect(mockApplyTaskModelSelectionToRun).not.toHaveBeenCalled();
  });

  it('applies for a run token bound to the requested task', async () => {
    mockTokenRunFindFirst.mockResolvedValue({ taskId: 'target-task' });
    const app = createApp({
      userId: undefined,
      authContext: { runId: 7 } as never,
    });

    const response = await postModelSelection(app as never, 'target-task');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      application: 'offline',
    });
    expect(mockApplyTaskModelSelectionToRun).toHaveBeenCalledWith({
      runId: 42,
      role: 'coding',
      model: null,
      reasoningEffort: null,
    });
  });

  it('applies for a user-token context without a bound run', async () => {
    const app = createApp({
      userId: 'user-1',
      authContext: { userId: 'user-1' } as never,
    });

    const response = await postModelSelection(app as never, 'target-task');

    expect(response.status).toBe(200);
    expect(mockTokenRunFindFirst).not.toHaveBeenCalled();
    expect(mockApplyTaskModelSelectionToRun).toHaveBeenCalled();
  });

  it('rejects contexts with neither a run token nor a user', async () => {
    const app = createApp({
      userId: undefined,
      authContext: { deployment: true } as never,
    });

    const response = await postModelSelection(app as never, 'target-task');

    expect(response.status).toBe(403);
    expect(mockApplyTaskModelSelectionToRun).not.toHaveBeenCalled();
  });
});

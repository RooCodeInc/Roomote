import { Hono } from 'hono';
import { RunStatus, type RunTokenContext } from '@roomote/types';

import type { Variables } from '../../types';

const { mockFindTaskRun } = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
    },
  },
  taskRuns: { id: 'taskRuns.id' },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

import {
  activeRunMcpAuthMiddleware,
  mcpAuthMiddleware,
  type McpAuth,
} from './middleware';

function createRunToken(): RunTokenContext {
  return {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };
}

function createApp(authContext: RunTokenContext, handler: () => void) {
  const app = new Hono<{
    Variables: Variables & { mcpAuth: McpAuth };
  }>();
  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.use('*', activeRunMcpAuthMiddleware);
  app.post('/', (c) => {
    handler();
    return c.json({ ok: true });
  });
  return app;
}

describe('mcpAuthMiddleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows an active run token to reach native MCP routes', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, status: RunStatus.Running });
    const handler = vi.fn();

    const response = await createApp(createRunToken(), handler).request('/', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([RunStatus.Completed, RunStatus.Failed, RunStatus.Canceled])(
    'rejects a %s run token before a native MCP route executes',
    async (status) => {
      mockFindTaskRun.mockResolvedValue({ id: 42, status });
      const handler = vi.fn();

      const response = await createApp(createRunToken(), handler).request('/', {
        method: 'POST',
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Task run is no longer active for this MCP token',
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );
});

import { Hono } from 'hono';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { tasksRouter } from '../index';

const { mockGetDeploymentTaskModelOptions } = vi.hoisted(() => ({
  mockGetDeploymentTaskModelOptions: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  getDeploymentTaskModelOptions: mockGetDeploymentTaskModelOptions,
}));

describe('listTaskModels', () => {
  beforeEach(() => {
    mockGetDeploymentTaskModelOptions.mockReset();
  });

  function createApp(authenticated: boolean) {
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set(
        'authContext',
        authenticated
          ? { userId: 'member-1', tokenType: 'auth', version: 1 }
          : undefined,
      );
      await next();
    });
    app.use('/tasks/*', mcpAuthMiddleware);
    app.route('/tasks', tasksRouter);
    return app;
  }

  it('lists deployment models through the authenticated task router', async () => {
    const options = {
      models: [
        {
          id: 'openai/gpt-5.6-luna',
          displayName: 'GPT 5.6 Luna',
          family: 'GPT',
        },
      ],
      defaultModelId: 'openai/gpt-5.6-luna',
    };
    mockGetDeploymentTaskModelOptions.mockResolvedValueOnce(options);
    const app = createApp(true);

    const response = await app.request('/tasks/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(options);
  });

  it('rejects unauthenticated model discovery', async () => {
    const response = await createApp(false).request('/tasks/models');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Authentication required',
    });
    expect(mockGetDeploymentTaskModelOptions).not.toHaveBeenCalled();
  });
});

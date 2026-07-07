import { Hono } from 'hono';

import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getEnvironment } from '../getEnvironment';

const { mockEnvironmentFindFirst } = vi.hoisted(() => ({
  mockEnvironmentFindFirst: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...original,
    db: {
      query: {
        environments: {
          findFirst: mockEnvironmentFindFirst,
        },
      },
    },
  };
});

function createApp(authContext?: AuthTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.get('/environments/:id', getEnvironment);

  return app;
}

describe('getEnvironment', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when auth context is missing', async () => {
    const app = createApp();

    const response = await app.request(
      new Request('http://localhost/environments/env-1'),
    );

    expect(response.status).toBe(401);
  });

  it('returns 404 when the environment does not exist', async () => {
    const app = createApp(authContext);
    mockEnvironmentFindFirst.mockResolvedValueOnce(null);

    const response = await app.request(
      new Request('http://localhost/environments/env-missing'),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Environment not found',
    });
  });

  it('returns environment config and repository mappings', async () => {
    const app = createApp(authContext);
    mockEnvironmentFindFirst.mockResolvedValueOnce({
      id: 'env-1',
      name: 'Eval Target',
      description: 'Test environment',
      config: {
        name: 'Eval Target',
        repositories: [{ repository: 'Roomote/eval-test-app' }],
      },
      repositoryMappings: [
        {
          repository: {
            id: 'repo-1',
            fullName: 'Roomote/eval-test-app',
          },
        },
      ],
    });

    const response = await app.request(
      new Request('http://localhost/environments/env-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: 'env-1',
      name: 'Eval Target',
      description: 'Test environment',
      config: {
        name: 'Eval Target',
        repositories: [{ repository: 'Roomote/eval-test-app' }],
      },
      repositories: [
        {
          id: 'repo-1',
          fullName: 'Roomote/eval-test-app',
        },
      ],
    });
  });
});

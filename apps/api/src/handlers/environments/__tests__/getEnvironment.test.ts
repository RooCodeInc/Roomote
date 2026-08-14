import { Hono } from 'hono';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import {
  ENVIRONMENT_READ_ADMIN_REQUIRED_ERROR,
  getEnvironment,
} from '../getEnvironment';

const { mockEnvironmentFindFirst, mockTaskRunFindFirst, mockUserFindFirst } =
  vi.hoisted(() => ({
    mockEnvironmentFindFirst: vi.fn(),
    mockTaskRunFindFirst: vi.fn(),
    mockUserFindFirst: vi.fn(),
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
        taskRuns: {
          findFirst: mockTaskRunFindFirst,
        },
        users: {
          findFirst: mockUserFindFirst,
        },
      },
    },
  };
});

function createApp(authContext?: AuthTokenContext | RunTokenContext) {
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
    mockUserFindFirst.mockResolvedValue({ role: 'admin', deletedAt: null });
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

  it.each([
    ['member', { role: 'member', deletedAt: null }],
    ['deleted admin', { role: 'admin', deletedAt: new Date() }],
  ])('rejects a %s before reading environment config', async (_label, user) => {
    mockUserFindFirst.mockResolvedValueOnce(user);
    const app = createApp(authContext);

    const response = await app.request(
      new Request('http://localhost/environments/env-1'),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: ENVIRONMENT_READ_ADMIN_REQUIRED_ERROR,
    });
    expect(mockEnvironmentFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a deployment-principal run with no acting user', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({ actingUserId: null });
    const app = createApp({
      runId: 42,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    });

    const response = await app.request(
      new Request('http://localhost/environments/env-1'),
    );

    expect(response.status).toBe(403);
    expect(mockUserFindFirst).not.toHaveBeenCalled();
    expect(mockEnvironmentFindFirst).not.toHaveBeenCalled();
  });

  it('allows an admin-driven ordinary task to read config for an update', async () => {
    mockTaskRunFindFirst
      .mockResolvedValueOnce({ actingUserId: 'admin-1' })
      .mockResolvedValueOnce({
        payloadKind: 'standard',
        payload: {},
        task: { workflow: 'standard' },
      });
    mockEnvironmentFindFirst.mockResolvedValueOnce({
      id: 'env-1',
      name: 'Repair target',
      description: null,
      config: { name: 'Repair target', repositories: [] },
      repositoryMappings: [],
    });
    const app = createApp({
      runId: 42,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    });

    const response = await app.request(
      new Request('http://localhost/environments/env-1'),
    );

    expect(response.status).toBe(200);
  });

  it('allows an admin-driven environment setup task to read config', async () => {
    mockTaskRunFindFirst
      .mockResolvedValueOnce({ actingUserId: 'admin-1' })
      .mockResolvedValueOnce({
        payloadKind: 'standard',
        payload: { environmentManagementMode: 'update' },
        task: { workflow: 'setup_onboarding' },
      });
    mockEnvironmentFindFirst.mockResolvedValueOnce({
      id: 'env-1',
      name: 'Setup target',
      description: null,
      config: { name: 'Setup target', repositories: [] },
      repositoryMappings: [],
    });
    const app = createApp({
      runId: 42,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    });

    const response = await app.request(
      new Request('http://localhost/environments/env-1'),
    );

    expect(response.status).toBe(200);
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

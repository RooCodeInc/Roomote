import { Hono } from 'hono';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getTaskSummary } from '../getTaskSummary';

const {
  andMock,
  eqMock,
  mockEnvironmentFindFirst,
  mockGetLatestTaskRunsByTaskIds,
  mockSelect,
  selectFromMock,
  selectLimitMock,
  selectWhereMock,
  visibleTaskHistoryCondition,
} = vi.hoisted(() => ({
  andMock: vi.fn((...args) => ({ type: 'and', args })),
  eqMock: vi.fn((...args) => ({ type: 'eq', args })),
  mockEnvironmentFindFirst: vi.fn(),
  mockGetLatestTaskRunsByTaskIds: vi.fn(),
  mockSelect: vi.fn(),
  selectFromMock: vi.fn(),
  selectLimitMock: vi.fn(),
  selectWhereMock: vi.fn(),
  visibleTaskHistoryCondition: { type: 'visibleTaskHistoryCondition' },
}));

vi.mock('../helpers', () => ({
  TASK_SELECT_COLUMNS: {
    id: 'tasks.id',
    title: 'tasks.title',
    mode: 'tasks.mode',
    completed: 'tasks.completed',
    harness: 'tasks.harness',
    timestamp: 'tasks.timestamp',
    activityAt: 'tasks.activityAt',
    repositoryName: 'tasks.repository_name',
  },
  getLatestTaskRunsByTaskIds: mockGetLatestTaskRunsByTaskIds,
  visibleTaskHistoryCondition,
}));

vi.mock('@roomote/db/server', () => ({
  and: andMock,
  db: {
    select: mockSelect,
    query: {
      environments: {
        findFirst: mockEnvironmentFindFirst,
      },
    },
  },
  environments: {
    id: 'environments.id',
  },
  eq: eqMock,
  tasks: { id: 'tasks.id', orgId: 'tasks.orgId' },
}));

function createApp(authContext?: AuthTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }

    await next();
  });

  app.use('*', mcpAuthMiddleware);
  app.get('/tasks/:taskId/summary', getTaskSummary);

  return app;
}

describe('getTaskSummary', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    selectFromMock.mockReturnValue({
      where: selectWhereMock,
    });
    selectWhereMock.mockReturnValue({
      limit: selectLimitMock,
    });
    selectLimitMock.mockResolvedValue([
      {
        id: 'task-1',
        title: 'Broken startup',
        mode: 'standard',
        completed: false,
        repositoryName: 'owner/repo',
        harness: 'opencode-server',
        timestamp: 1,
        activityAt: 2,
      },
    ]);
    mockSelect.mockReturnValue({
      from: selectFromMock,
    });
    mockGetLatestTaskRunsByTaskIds.mockResolvedValue({
      'task-1': {
        id: 101,
        taskId: 'task-1',
        status: 'failed',
        taskPhase: null,
        error: 'Sandbox startup timed out',
        payload: {
          environmentDefinitionId: 'env-123',
        },
      },
    });
    mockEnvironmentFindFirst.mockResolvedValue({
      id: 'env-123',
      name: 'Onboarding Sandbox',
    });
  });

  it('returns the latest task run error in the summary payload', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'task-1',
      taskRunStatus: 'failed',
      taskRunError: 'Sandbox startup timed out',
    });
  });

  it('adds the hidden-task-history condition to the summary query', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );

    expect(response.status).toBe(200);
    expect(andMock).toHaveBeenCalled();
    expect(andMock.mock.calls[0]).toContain(visibleTaskHistoryCondition);
  });

  it('returns 404 when the task is hidden from task history', async () => {
    selectLimitMock.mockResolvedValueOnce([]);

    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Task not found' });
  });

  it('includes the linked environment id and name from the latest task run payload', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      linkedEnvironmentId: 'env-123',
      linkedEnvironmentName: 'Onboarding Sandbox',
    });
    expect(mockEnvironmentFindFirst).toHaveBeenCalledTimes(1);
  });

  it('returns null linked environment fields when the latest job has no linked environment', async () => {
    mockGetLatestTaskRunsByTaskIds.mockResolvedValueOnce({
      'task-1': {
        id: 101,
        taskId: 'task-1',
        status: 'completed',
        taskPhase: null,
        error: null,
        payload: {},
      },
    });

    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      linkedEnvironmentId: null,
      linkedEnvironmentName: null,
    });
    expect(mockEnvironmentFindFirst).not.toHaveBeenCalled();
  });
});

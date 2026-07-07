import { Hono } from 'hono';
import { CloudTaskType, HAS_PULL_REQUEST_FILTER_VALUE } from '@roomote/types';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { searchTasks } from '../searchTasks';

const {
  mockDbSelect,
  mockGetLatestCloudJobsByTaskIds,
  mockLogHandlerError,
  visibleTaskHistoryCondition,
  mockSql,
  selectWhereMock,
  selectOrderByMock,
  selectLimitMock,
  andMock,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockGetLatestCloudJobsByTaskIds: vi.fn(),
  mockLogHandlerError: vi.fn(),
  visibleTaskHistoryCondition: { type: 'visibleTaskHistoryCondition' },
  mockSql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    type: 'sql',
    text: strings.join('?'),
    values,
  })),
  selectWhereMock: vi.fn(),
  selectOrderByMock: vi.fn(),
  selectLimitMock: vi.fn(),
  andMock: vi.fn((...args) => ({ type: 'and', args })),
}));

vi.mock('../helpers', () => ({
  TASK_SELECT_COLUMNS: { id: 'tasks.id', title: 'tasks.title' },
  getLatestCloudJobsByTaskIds: mockGetLatestCloudJobsByTaskIds,
  visibleTaskHistoryCondition,
  logHandlerError: mockLogHandlerError,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    selectDistinct: mockDbSelect,
  },
  tasks: {
    id: 'tasks.id',
    completed: 'tasks.completed',
    activityAt: 'tasks.activityAt',
    title: 'tasks.title',
  },
  cloudJobs: {
    taskId: 'cloudJobs.taskId',
    prRepo: 'cloudJobs.prRepo',
    prNumber: 'cloudJobs.prNumber',
    payload: 'cloudJobs.payload',
  },
  taskPullRequests: {
    taskId: 'taskPullRequests.taskId',
    repository: 'taskPullRequests.repository',
    prNumber: 'taskPullRequests.prNumber',
  },
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  and: andMock,
  desc: vi.fn((arg) => ({ type: 'desc', arg })),
  lt: vi.fn((...args) => ({ type: 'lt', args })),
  sql: mockSql,
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
  app.get('/tasks', searchTasks);

  return app;
}

describe('searchTasks', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    selectWhereMock.mockReturnValue({
      orderBy: selectOrderByMock,
    });
    selectOrderByMock.mockReturnValue({
      limit: selectLimitMock,
    });
    selectLimitMock.mockResolvedValue([
      {
        id: 'task-1',
        title: 'Generated title',
        mode: 'standard',
        completed: false,
        repositoryName: '__all_repositories__',
        harness: 'opencode-server',
        timestamp: 1,
        activityAt: 2,
      },
    ]);
    mockDbSelect.mockReturnValue({
      from: vi.fn(() => ({
        where: selectWhereMock,
      })),
    });
    mockGetLatestCloudJobsByTaskIds.mockResolvedValue({});
  });

  it('matches query text against task titles and launch prompts', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks?query=fix%20tests',
    );

    expect(response.status).toBe(200);
    const promptSearchCondition = mockSql.mock.calls.find(
      ([strings]) =>
        strings.join('?').includes('EXISTS') &&
        strings.join('?').includes('description'),
    );
    expect(promptSearchCondition).toBeDefined();
  });

  it('filters to tasks with any associated pull request', async () => {
    const response = await createApp(authContext).request(
      `http://localhost/tasks?pullRequest=${encodeURIComponent(HAS_PULL_REQUEST_FILTER_VALUE)}`,
    );

    expect(response.status).toBe(200);

    const hasPrCondition = mockSql.mock.calls.find(([, ...values]) => {
      return (
        values.includes('taskPullRequests.repository') &&
        values.includes('taskPullRequests.prNumber')
      );
    });

    expect(hasPrCondition).toBeDefined();
  });

  it('filters to tasks linked to a specific pull request', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks?pullRequest=owner%2Frepo%23123',
    );

    expect(response.status).toBe(200);

    const specificPrCondition = mockSql.mock.calls.find(([, ...values]) => {
      return values.includes('owner/repo') && values.includes(123);
    });

    expect(specificPrCondition).toBeDefined();
  });

  it('returns a 400 for malformed pullRequest filters', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks?pullRequest=owner%2Frepo%23bad',
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'pullRequest must be "__has_pr__" or in the format owner/repo#number',
    });
  });

  it.each(['owner/repo#123abc', 'owner/repo#123#extra'])(
    'returns a 400 for malformed pullRequest value %s',
    async (value) => {
      const response = await createApp(authContext).request(
        `http://localhost/tasks?pullRequest=${encodeURIComponent(value)}`,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error:
          'pullRequest must be "__has_pr__" or in the format owner/repo#number',
      });
    },
  );

  it('returns a 400 for invalid status', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks?status=bad',
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'status must be one of: active, completed, all',
    });
  });

  it('includes the latest cloud job error in each task row', async () => {
    mockGetLatestCloudJobsByTaskIds.mockResolvedValueOnce({
      'task-1': {
        id: 7,
        taskId: 'task-1',
        type: CloudTaskType.StandardTask,
        status: 'failed',
        taskPhase: null,
        error: 'Sandbox startup timed out',
      },
    });

    const response = await createApp(authContext).request(
      'http://localhost/tasks',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tasks: [
        {
          id: 'task-1',
          cloudJobStatus: 'failed',
          cloudJobError: 'Sandbox startup timed out',
        },
      ],
    });
  });

  it('keeps the hidden latest-job safety filter in the MCP task response', async () => {
    selectLimitMock.mockResolvedValueOnce([
      {
        id: 'task-hidden',
        title: 'Hidden task',
        mode: 'standard',
        completed: false,
        repositoryName: 'hidden/repo',
        harness: 'opencode-server',
        timestamp: 1,
        activityAt: 3,
      },
      {
        id: 'task-visible',
        title: 'Visible task',
        mode: 'standard',
        completed: false,
        repositoryName: 'visible/repo',
        harness: 'opencode-server',
        timestamp: 1,
        activityAt: 2,
      },
    ]);
    mockGetLatestCloudJobsByTaskIds.mockResolvedValueOnce({
      'task-hidden': {
        id: 8,
        taskId: 'task-hidden',
        type: CloudTaskType.SuggestedTasks,
        status: 'completed',
        taskPhase: null,
        error: null,
      },
      'task-visible': {
        id: 9,
        taskId: 'task-visible',
        type: CloudTaskType.StandardTask,
        status: 'completed',
        taskPhase: null,
        error: null,
      },
    });

    const response = await createApp(authContext).request(
      'http://localhost/tasks',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tasks: [
        {
          id: 'task-visible',
        },
      ],
    });
  });

  it('adds the hidden-task-history condition to the MCP task query', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks',
    );

    expect(response.status).toBe(200);
    expect(andMock).toHaveBeenCalled();
    expect(andMock.mock.calls[0]).toContain(visibleTaskHistoryCondition);
  });
});

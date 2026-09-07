import { Hono } from 'hono';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getTaskSummary } from '../getTaskSummary';

const {
  andMock,
  eqMock,
  mockEnvironmentFindFirst,
  mockReportFindFirst,
  mockGetLatestTaskRunsByTaskIds,
  mockListArtifactsByTask,
  mockSelect,
  selectFromMock,
  selectLimitMock,
  selectWhereMock,
  visibleTaskHistoryCondition,
} = vi.hoisted(() => ({
  andMock: vi.fn((...args) => ({ type: 'and', args })),
  eqMock: vi.fn((...args) => ({ type: 'eq', args })),
  mockEnvironmentFindFirst: vi.fn(),
  mockReportFindFirst: vi.fn(),
  mockGetLatestTaskRunsByTaskIds: vi.fn(),
  mockListArtifactsByTask: vi.fn(),
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

vi.mock('../../artifacts/service', () => ({
  listArtifactsByTask: mockListArtifactsByTask,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    R_APP_URL: 'https://api.roomote.example',
    R_PUBLIC_URL: 'https://roomote.example',
  },
}));

vi.mock('@roomote/db/server', () => ({
  and: andMock,
  desc: vi.fn((column) => ({ desc: column })),
  sql: vi.fn((strings, ...values) => ({ strings: [...strings], values })),
  db: {
    select: mockSelect,
    query: {
      environments: {
        findFirst: mockEnvironmentFindFirst,
      },
      fastAgentParentEvents: { findFirst: mockReportFindFirst },
    },
  },
  environments: {
    id: 'environments.id',
  },
  eq: eqMock,
  tasks: { id: 'tasks.id', orgId: 'tasks.orgId' },
  fastAgentParentEvents: {
    conversationId: 'fastAgentParentEvents.conversationId',
    event: 'fastAgentParentEvents.event',
    createdAt: 'fastAgentParentEvents.createdAt',
    id: 'fastAgentParentEvents.id',
  },
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
        environmentSetupState: 'failed',
        payload: {
          environmentDefinitionId: 'env-123',
          fastAgentParent: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            conversation: {
              surface: 'web',
              workspaceId: 'user-1',
              conversationId: '11111111-1111-4111-8111-111111111111',
              replyTarget: {},
            },
          },
        },
      },
    });
    mockEnvironmentFindFirst.mockResolvedValue({
      id: 'env-123',
      name: 'Onboarding Sandbox',
    });
    mockListArtifactsByTask.mockResolvedValue([]);
    mockReportFindFirst.mockResolvedValue(undefined);
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
      environmentSetupState: 'failed',
      summary: null,
    });
  });

  it('includes the actual task report, with secrets redacted, in the result', async () => {
    mockReportFindFirst.mockResolvedValueOnce({
      event: {
        message: 'Fixed the retry race.\nTests pass. token=secret-value',
      },
    });
    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );
    const body = await response.json();
    expect(body.summary).toContain('Fixed the retry race.\nTests pass.');
    expect(body.summary).not.toContain('secret-value');
  });

  it.each([null, '', '  ', 123])(
    'returns null for missing or invalid report text',
    async (message) => {
      mockReportFindFirst.mockResolvedValueOnce({ event: { message } });
      const response = await createApp(authContext).request(
        'http://localhost/tasks/task-1/summary',
      );
      await expect(response.json()).resolves.toMatchObject({ summary: null });
    },
  );

  it('adds the hidden-task-history condition to the summary query', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );

    expect(response.status).toBe(200);
    expect(andMock).toHaveBeenCalled();
    expect(andMock.mock.calls[0]).toContain(visibleTaskHistoryCondition);
  });

  it('returns stable IDs and viewer links for uploaded task images', async () => {
    mockListArtifactsByTask.mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        taskId: 'task-1',
        runId: 101,
        path: 'proof/final image.png',
        version: 2,
        artifactType: 'visual-proof',
        contentType: 'image/png',
        size: 123,
        uploaded: true,
        createdAt: new Date('2026-04-21T12:00:00Z'),
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        taskId: 'task-1',
        runId: 101,
        path: 'report.txt',
        version: 1,
        artifactType: 'general',
        contentType: 'text/plain',
        size: 10,
        uploaded: true,
        createdAt: new Date('2026-04-21T12:00:01Z'),
      },
    ]);

    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      imageArtifacts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          path: 'proof/final image.png',
          version: 2,
          artifactType: 'visual-proof',
          contentType: 'image/png',
          viewUrl:
            'https://roomote.example/task/task-1/artifacts/proof/final%20image.png?v=2',
        },
      ],
    });
  });

  it('returns 404 when the task is hidden from task history', async () => {
    selectLimitMock.mockResolvedValueOnce([]);

    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/summary',
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Task not found' });
    expect(mockListArtifactsByTask).not.toHaveBeenCalled();
    expect(mockReportFindFirst).not.toHaveBeenCalled();
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

  it('includes the linked environment from a standard task run payload', async () => {
    mockGetLatestTaskRunsByTaskIds.mockResolvedValueOnce({
      'task-1': {
        id: 101,
        taskId: 'task-1',
        status: 'running',
        taskPhase: null,
        error: null,
        payload: { environmentId: 'env-123' },
      },
    });

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
      summary: null,
    });
    expect(mockEnvironmentFindFirst).not.toHaveBeenCalled();
    expect(mockReportFindFirst).not.toHaveBeenCalled();
  });
});

import { Hono } from 'hono';

import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { sendMessage } from '../sendMessage';
import { steerMessage } from '../steerMessage';

const {
  mockSendMessageToTask,
  mockSteerMessageToTask,
  mockTaskRunsFindFirst,
  mockGetTaskHumanOwnerUserIds,
} = vi.hoisted(() => ({
  mockSendMessageToTask: vi.fn(),
  mockSteerMessageToTask: vi.fn(),
  mockTaskRunsFindFirst: vi.fn(),
  mockGetTaskHumanOwnerUserIds: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  taskRuns: {},
  getTaskHumanOwnerUserIds: (...args: unknown[]) =>
    mockGetTaskHumanOwnerUserIds(...args),
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockTaskRunsFindFirst(...args),
      },
    },
  },
}));

vi.mock('../sendMessageToTask', () => ({
  sendMessageToTask: (...args: unknown[]) => mockSendMessageToTask(...args),
  steerMessageToTask: (...args: unknown[]) => mockSteerMessageToTask(...args),
}));

vi.mock('../fastSessionCommunication', () => ({
  sendMessageToFastSessionForUser: vi.fn(),
}));

function createApp(authContext: RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.post('/tasks/:taskId/send_message', sendMessage);
  app.post('/tasks/:taskId/steer_message', steerMessage);

  return app;
}

const userlessRunAuth: RunTokenContext = {
  runId: 555,
  userId: null,
  principal: 'deployment',
  tokenType: 'run',
  version: 1,
};

function post(app: Hono<{ Variables: Variables }>, path: string) {
  return app.request(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Review results: looks good' }),
    }),
  );
}

describe('send_message / steer_message user context', () => {
  beforeEach(() => {
    mockSendMessageToTask.mockReset();
    mockSendMessageToTask.mockResolvedValue({ success: true, result: {} });
    mockSteerMessageToTask.mockReset();
    mockSteerMessageToTask.mockResolvedValue({ success: true, result: {} });
    mockTaskRunsFindFirst.mockReset();
    mockGetTaskHumanOwnerUserIds.mockReset();
    mockGetTaskHumanOwnerUserIds.mockResolvedValue([]);
  });

  it('send_message resolves the current acting user for a userless run token', async () => {
    mockTaskRunsFindFirst.mockResolvedValue({
      actingUserId: 'user-current',
      taskId: 'task-review',
    });

    const response = await post(
      createApp(userlessRunAuth),
      '/tasks/task-impl/send_message',
    );

    expect(response.status).toBe(200);
    expect(mockSendMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-impl', userId: 'user-current' }),
    );
  });

  it('send_message falls back to the task human owner when the run has no acting user', async () => {
    mockTaskRunsFindFirst.mockResolvedValue({
      actingUserId: null,
      taskId: 'task-review',
    });
    mockGetTaskHumanOwnerUserIds.mockResolvedValue(['user-owner']);

    const response = await post(
      createApp(userlessRunAuth),
      '/tasks/task-impl/send_message',
    );

    expect(response.status).toBe(200);
    expect(mockGetTaskHumanOwnerUserIds).toHaveBeenCalledWith(
      expect.anything(),
      'task-review',
    );
    expect(mockSendMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-owner' }),
    );
  });

  it('steer_message resolves the run user the same way', async () => {
    mockTaskRunsFindFirst.mockResolvedValue({
      actingUserId: null,
      taskId: 'task-review',
    });
    mockGetTaskHumanOwnerUserIds.mockResolvedValue(['user-owner']);

    const response = await post(
      createApp(userlessRunAuth),
      '/tasks/task-impl/steer_message',
    );

    expect(response.status).toBe(200);
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-impl', userId: 'user-owner' }),
    );
  });

  it('still rejects when no user can be resolved for the run', async () => {
    mockTaskRunsFindFirst.mockResolvedValue({
      actingUserId: null,
      taskId: 'task-review',
    });

    const response = await post(
      createApp(userlessRunAuth),
      '/tasks/task-impl/send_message',
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'User context required' });
    expect(mockSendMessageToTask).not.toHaveBeenCalled();
  });
});

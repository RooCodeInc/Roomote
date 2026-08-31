import { Hono } from 'hono';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getTaskMessages } from '../getTaskMessages';

const {
  andMock,
  ascMock,
  descMock,
  eqMock,
  mockGetImageUrisFromContentBlocks,
  mockGetFastSessionMessagesForUser,
  mockGetTextFromContentBlocks,
  mockLogHandlerError,
  mockResolveAcpTranscriptVisibility,
  mockSelect,
  selectFromMock,
  selectOrderByMock,
  selectWhereMock,
  taskSelectFromMock,
  taskSelectLimitMock,
  taskSelectWhereMock,
  visibleTaskHistoryCondition,
} = vi.hoisted(() => ({
  andMock: vi.fn((...args) => ({ type: 'and', args })),
  ascMock: vi.fn((value) => ({ type: 'asc', value })),
  descMock: vi.fn((value) => ({ type: 'desc', value })),
  eqMock: vi.fn((...args) => ({ type: 'eq', args })),
  mockGetImageUrisFromContentBlocks: vi.fn(() => [
    'https://example.com/image.png',
  ]),
  mockGetFastSessionMessagesForUser: vi.fn(),
  mockGetTextFromContentBlocks: vi.fn(() => 'Hello from transcript'),
  mockLogHandlerError: vi.fn(),
  mockResolveAcpTranscriptVisibility: vi.fn(() => true),
  mockSelect: vi.fn(),
  selectFromMock: vi.fn(),
  selectOrderByMock: vi.fn(),
  selectWhereMock: vi.fn(),
  taskSelectFromMock: vi.fn(),
  taskSelectLimitMock: vi.fn(),
  taskSelectWhereMock: vi.fn(),
  visibleTaskHistoryCondition: { type: 'visibleTaskHistoryCondition' },
}));

vi.mock('../helpers', () => ({
  visibleTaskHistoryCondition,
}));

vi.mock('../fastSessionCommunication', () => ({
  getFastSessionMessagesForUser: mockGetFastSessionMessagesForUser,
}));

vi.mock('../../utils', () => ({
  logHandlerError: mockLogHandlerError,
}));

vi.mock('@roomote/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/types')>();

  return {
    ...original,
    getImageUrisFromContentBlocks: mockGetImageUrisFromContentBlocks,
    getTextFromContentBlocks: mockGetTextFromContentBlocks,
    resolveAcpTranscriptVisibility: mockResolveAcpTranscriptVisibility,
  };
});

vi.mock('@roomote/db/server', () => ({
  and: andMock,
  asc: ascMock,
  db: {
    select: mockSelect,
  },
  desc: descMock,
  eq: eqMock,
  taskMessages: {
    id: 'taskMessages.id',
    taskId: 'taskMessages.taskId',
    ts: 'taskMessages.ts',
    eventType: 'taskMessages.eventType',
    role: 'taskMessages.role',
    contentBlocks: 'taskMessages.contentBlocks',
    metadata: 'taskMessages.metadata',
    payload: 'taskMessages.payload',
    createdAt: 'taskMessages.createdAt',
  },
  tasks: {
    id: 'tasks.id',
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
  app.get('/tasks/:taskId/messages', getTaskMessages);

  return app;
}

describe('getTaskMessages', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReset();
    mockGetFastSessionMessagesForUser.mockResolvedValue(null);

    taskSelectFromMock.mockReturnValue({
      where: taskSelectWhereMock,
    });
    taskSelectWhereMock.mockReturnValue({
      limit: taskSelectLimitMock,
    });
    taskSelectLimitMock.mockResolvedValue([{ id: 'task-1' }]);

    selectFromMock.mockReturnValue({
      where: selectWhereMock,
    });
    selectWhereMock.mockReturnValue({
      orderBy: selectOrderByMock,
    });
    selectOrderByMock.mockResolvedValue([
      {
        id: 'message-1',
        taskId: 'task-1',
        ts: 123n,
        eventType: 'message',
        role: 'assistant',
        contentBlocks: [],
        metadata: { foo: 'bar' },
        payload: { kind: 'payload' },
        createdAt: new Date('2026-04-21T12:00:00Z'),
      },
    ]);

    mockSelect
      .mockReturnValueOnce({
        from: taskSelectFromMock,
      })
      .mockReturnValueOnce({
        from: selectFromMock,
      });
  });

  it('returns task messages for visible tasks', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/messages',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      returned: 1,
      messages: [
        {
          id: 'message-1',
          taskId: 'task-1',
          ts: 123,
          role: 'assistant',
          text: 'Hello from transcript',
          images: ['https://example.com/image.png'],
          visibleInTranscript: true,
        },
      ],
    });
    expect(mockGetFastSessionMessagesForUser).not.toHaveBeenCalled();
  });

  it('adds the hidden-task-history condition to the task lookup', async () => {
    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/messages',
    );

    expect(response.status).toBe(200);
    expect(andMock).toHaveBeenCalled();
    expect(andMock.mock.calls[0]).toContain(visibleTaskHistoryCondition);
  });

  it('omits transcript-hidden task messages from MCP responses', async () => {
    mockResolveAcpTranscriptVisibility.mockReturnValueOnce(false);

    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/messages',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [],
      returned: 0,
    });
  });

  it('returns 404 when the task is hidden from task history', async () => {
    taskSelectLimitMock.mockResolvedValueOnce([]);

    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/messages',
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Task not found' });
  });

  it('falls back to a Fast session when no task matches', async () => {
    taskSelectLimitMock.mockResolvedValueOnce([]);
    mockGetFastSessionMessagesForUser.mockResolvedValueOnce([
      {
        id: 'fast-message-1',
        taskId: 'fast-session-1',
        text: 'Fast response',
      },
    ]);

    const response = await createApp(authContext).request(
      'http://localhost/tasks/fast-session-1/messages',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      returned: 1,
      messages: [{ taskId: 'fast-session-1', text: 'Fast response' }],
    });
    expect(mockGetFastSessionMessagesForUser).toHaveBeenCalledWith({
      sessionId: 'fast-session-1',
      userId: 'user-1',
      limit: undefined,
      order: 'asc',
    });
  });

  it('forwards explicit descending order to Fast session fallback', async () => {
    taskSelectLimitMock.mockResolvedValueOnce([]);
    mockGetFastSessionMessagesForUser.mockResolvedValueOnce([]);

    const response = await createApp(authContext).request(
      'http://localhost/tasks/fast-session-1/messages?order=desc',
    );

    expect(response.status).toBe(200);
    expect(mockGetFastSessionMessagesForUser).toHaveBeenCalledWith({
      sessionId: 'fast-session-1',
      userId: 'user-1',
      limit: undefined,
      order: 'desc',
    });
  });
});

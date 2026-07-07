import { Hono } from 'hono';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';

const {
  describeVideoAttachmentMock,
  logHandlerErrorMock,
  mockFindFirstTask,
  andMock,
  eqMock,
  visibleTaskHistoryCondition,
} = vi.hoisted(() => ({
  describeVideoAttachmentMock: vi.fn(),
  logHandlerErrorMock: vi.fn(),
  mockFindFirstTask: vi.fn(),
  andMock: vi.fn((...args) => ({ type: 'and', args })),
  eqMock: vi.fn((...args) => ({ type: 'eq', args })),
  visibleTaskHistoryCondition: { type: 'visibleTaskHistoryCondition' },
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => {
  const actualVideoAgent =
    await importOriginal<typeof import('@roomote/cloud-agents/server')>();

  return {
    ...actualVideoAgent,
    describeVideoAttachment: describeVideoAttachmentMock,
  };
});

vi.mock('../helpers', () => ({
  visibleTaskHistoryCondition,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      tasks: {
        findFirst: mockFindFirstTask,
      },
    },
  },
  tasks: { id: 'tasks.id', orgId: 'tasks.orgId' },
  eq: eqMock,
  and: andMock,
}));

vi.mock('../../utils', () => ({
  logHandlerError: logHandlerErrorMock,
}));

async function createApp(authContext?: AuthTokenContext) {
  const { describeVideo } = await import('../describeVideo');
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }

    await next();
  });

  app.use('*', mcpAuthMiddleware);
  app.post('/tasks/:taskId/describe_video', describeVideo);

  return app;
}

describe('describeVideo request shape integration', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstTask.mockResolvedValue({ id: 'task-1' });
    describeVideoAttachmentMock.mockResolvedValue(
      'The video shows a settings page with a red validation banner.',
    );
  });

  it('passes decoded video bytes and request metadata through the real handler path', async () => {
    const videoBytes = Buffer.from('tiny-video-buffer');
    const app = await createApp(authContext);

    const response = await app.request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoBytes: videoBytes.toString('base64'),
          mimeType: 'video/mp4',
          userTextContext: 'Focus on the visible form error.',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      description:
        'The video shows a settings page with a red validation banner.',
    });
    expect(describeVideoAttachmentMock).toHaveBeenCalledWith({
      videoBytes,
      mimeType: 'video/mp4',
      userTextContext: 'Focus on the visible form error.',
      userId: 'user-1',
      taskId: 'task-1',
    });
    expect(logHandlerErrorMock).not.toHaveBeenCalled();
  });
});

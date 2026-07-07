import { Hono } from 'hono';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { describeVideo } from '../describeVideo';

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

vi.mock('@roomote/cloud-agents/server', () => ({
  describeVideoAttachment: describeVideoAttachmentMock,
  isVideoAgentSupportedMimeType: vi.fn((mimeType: string) =>
    ['video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg'].includes(
      mimeType,
    ),
  ),
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES: 20 * 1024 * 1024,
}));

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

function createBodyStream(
  totalBytes: number,
  chunkSize = 1024 * 1024,
): ReadableStream<Uint8Array> {
  let bytesSent = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytesSent >= totalBytes) {
        controller.close();
        return;
      }

      const nextChunkSize = Math.min(chunkSize, totalBytes - bytesSent);
      controller.enqueue(new Uint8Array(nextChunkSize).fill(97));
      bytesSent += nextChunkSize;
    },
  });
}

function createApp(authContext?: AuthTokenContext) {
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

describe('describeVideo', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    describeVideoAttachmentMock.mockResolvedValue('A short screen recording.');
    mockFindFirstTask.mockResolvedValue({ id: 'task-1' });
  });

  it('returns 401 when auth context is missing', async () => {
    const response = await createApp().request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoBytes: Buffer.from('video').toString('base64'),
          mimeType: 'video/mp4',
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('returns a description for valid JSON payloads', async () => {
    const response = await createApp(authContext).request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoBytes: Buffer.from('video-data').toString('base64'),
          mimeType: 'video/mp4',
          userTextContext: 'Focus on the error banner.',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      description: 'A short screen recording.',
    });
    expect(describeVideoAttachmentMock).toHaveBeenCalledWith({
      videoBytes: Buffer.from('video-data'),
      mimeType: 'video/mp4',
      userTextContext: 'Focus on the error banner.',
      userId: 'user-1',
      taskId: 'task-1',
    });
    expect(andMock).toHaveBeenCalled();
    expect(andMock.mock.calls[0]).toContain(visibleTaskHistoryCondition);
  });

  it('accepts multipart form payloads', async () => {
    const formData = new FormData();
    formData.set(
      'videoBytes',
      Buffer.from('multipart-video').toString('base64'),
    );
    formData.set('mimeType', 'video/webm');
    formData.set('userTextContext', 'Look for UI state changes.');

    const response = await createApp(authContext).request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        body: formData,
      }),
    );

    expect(response.status).toBe(200);
    expect(describeVideoAttachmentMock).toHaveBeenCalledWith({
      videoBytes: Buffer.from('multipart-video'),
      mimeType: 'video/webm',
      userTextContext: 'Look for UI state changes.',
      userId: 'user-1',
      taskId: 'task-1',
    });
  });

  it('rejects unsupported mime types', async () => {
    const response = await createApp(authContext).request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoBytes: Buffer.from('video').toString('base64'),
          mimeType: 'video/avi',
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Unsupported video mimeType: video/avi',
    });
    expect(describeVideoAttachmentMock).not.toHaveBeenCalled();
  });

  it('rejects videos larger than 20 MiB', async () => {
    const response = await createApp(authContext).request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoBytes: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64'),
          mimeType: 'video/mp4',
        }),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Video exceeds max size of 20971520 bytes',
    });
    expect(describeVideoAttachmentMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the task does not belong to the org', async () => {
    mockFindFirstTask.mockResolvedValueOnce(null);

    const response = await createApp(authContext).request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoBytes: Buffer.from('video').toString('base64'),
          mimeType: 'video/mp4',
        }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Task not found',
    });
    expect(describeVideoAttachmentMock).not.toHaveBeenCalled();
  });

  it('rejects oversized requests before parsing the body', async () => {
    const response = await createApp(authContext).request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(30 * 1024 * 1024),
        },
        body: '{',
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Request body exceeds max size of 28224172 bytes',
    });
    expect(mockFindFirstTask).not.toHaveBeenCalled();
    expect(describeVideoAttachmentMock).not.toHaveBeenCalled();
  });

  it('rejects oversized streamed requests without relying on content-length', async () => {
    const streamedRequest = new Request(
      'http://localhost/tasks/task-1/describe_video',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: createBodyStream(30 * 1024 * 1024),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );

    const response = await createApp(authContext).request(streamedRequest);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Request body exceeds max size of 28224172 bytes',
    });
    expect(mockFindFirstTask).toHaveBeenCalledOnce();
    expect(describeVideoAttachmentMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the description service returns no description', async () => {
    describeVideoAttachmentMock.mockResolvedValueOnce(null);

    const response = await createApp(authContext).request(
      new Request('http://localhost/tasks/task-1/describe_video', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoBytes: Buffer.from('video').toString('base64'),
          mimeType: 'video/mp4',
        }),
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to describe video',
    });
  });
});

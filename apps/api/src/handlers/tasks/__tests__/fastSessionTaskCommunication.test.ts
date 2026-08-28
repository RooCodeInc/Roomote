const mocks = vi.hoisted(() => ({
  queueReply: vi.fn(),
  sendMessageToTask: vi.fn(),
  steerMessageToTask: vi.fn(),
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/sdk/server')>();
  return { ...original, queueFastAgentSurfaceReply: mocks.queueReply };
});

vi.mock('../sendMessageToTask', () => ({
  sendMessageToTask: mocks.sendMessageToTask,
  steerMessageToTask: mocks.steerMessageToTask,
}));

import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';
import {
  db,
  fastAgentConversations,
  fastAgentMessages,
  userFactory,
} from '@roomote/db/server';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getTaskMessages } from '../getTaskMessages';
import { sendMessage } from '../sendMessage';
import { steerMessage } from '../steerMessage';

function createApp(authContext: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.get('/tasks/:taskId/messages', getTaskMessages);
  app.post('/tasks/:taskId/send_message', sendMessage);
  app.post('/tasks/:taskId/steer_message', steerMessage);
  return app;
}

async function createSession(userId: string) {
  const [session] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface: 'web',
      workspaceId: userId,
      conversationId: crypto.randomUUID(),
    })
    .returning();
  return session!;
}

async function addMessage(input: {
  sessionId: string;
  eventId: string;
  userId?: string;
  visible?: boolean;
  text?: string;
}) {
  await db.insert(fastAgentMessages).values({
    conversationId: input.sessionId,
    eventId: input.eventId,
    turnId: input.eventId,
    turnSeq: 0,
    ts: Date.now(),
    eventType: 'roomote_runtime.user_prompt',
    role: 'user',
    contentBlocks: [{ type: 'text', text: input.text ?? input.eventId }],
    metadata: {
      visibleInTranscript: input.visible ?? true,
      ...(input.userId ? { userId: input.userId } : {}),
    },
    payload: {},
    source: 'web',
  });
}

function userAuth(userId: string): AuthTokenContext {
  return { userId, tokenType: 'auth', version: 1 };
}

describe('Fast session communication through task routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queueReply.mockResolvedValue(true);
    mocks.sendMessageToTask.mockResolvedValue({
      success: false,
      status: 404,
      error: 'Task not found',
    });
    mocks.steerMessageToTask.mockResolvedValue({
      success: false,
      status: 404,
      error: 'Task not found',
    });
  });

  it('returns visible Fast transcript messages with the task-shaped contract', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const session = await createSession(owner.id);
    await addMessage({
      sessionId: session.id,
      eventId: 'participant-message',
      userId: participant.id,
      text: 'Participant text',
    });
    await addMessage({
      sessionId: session.id,
      eventId: 'hidden-message',
      visible: false,
    });

    for (const userId of [owner.id, participant.id]) {
      const response = await createApp(userAuth(userId)).request(
        `/tasks/${session.id}/messages?order=desc`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        returned: 1,
        messages: [
          {
            taskId: session.id,
            text: 'Participant text',
            visibleInTranscript: true,
          },
        ],
      });
    }
  });

  it('hides Fast sessions from bystanders and rejects absent or invalid IDs', async () => {
    const owner = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createSession(owner.id);

    for (const taskId of [session.id, crypto.randomUUID(), 'not-an-id']) {
      const response = await createApp(userAuth(bystander.id)).request(
        `/tasks/${taskId}/messages`,
      );
      expect(response.status).toBe(404);
    }
  });

  it('queues participant follow-ups after normal task resolution misses', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const session = await createSession(owner.id);
    await addMessage({
      sessionId: session.id,
      eventId: 'participant-message',
      userId: participant.id,
    });

    const response = await createApp(userAuth(participant.id)).request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Continue this conversation',
          images: ['https://example.com/member.png'],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(mocks.sendMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: session.id }),
    );
    expect(mocks.queueReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        userId: participant.id,
        question: 'Continue this conversation',
        images: ['https://example.com/member.png'],
      }),
    );
  });

  it('uses the same Fast fallback for the worker steering route', async () => {
    const owner = await userFactory.create();
    const session = await createSession(owner.id);

    const response = await createApp(userAuth(owner.id)).request(
      `/tasks/${session.id}/steer_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Worker follow-up',
          images: ['https://example.com/worker.png'],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(mocks.steerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: session.id }),
    );
    expect(mocks.queueReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        question: 'Worker follow-up',
        images: ['https://example.com/worker.png'],
      }),
    );
  });

  it('preserves normal task send behavior without attempting Fast delivery', async () => {
    const user = await userFactory.create();
    mocks.sendMessageToTask.mockResolvedValueOnce({
      success: true,
      result: { queued: true },
    });

    const response = await createApp(userAuth(user.id)).request(
      '/tasks/normal-task/send_message',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Normal follow-up' }),
      },
    );
    expect(response.status).toBe(200);
    expect(mocks.queueReply).not.toHaveBeenCalled();
  });

  it('preserves actor and provider boundaries for Fast sends', async () => {
    const owner = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createSession(owner.id);

    const denied = await createApp(userAuth(bystander.id)).request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Not allowed' }),
      },
    );
    expect(denied.status).toBe(404);

    const deploymentRun: RunTokenContext = {
      runId: 1,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    };
    const noActor = await createApp(deploymentRun).request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'No actor' }),
      },
    );
    expect(noActor.status).toBe(403);

    mocks.queueReply.mockResolvedValueOnce(false);
    const unavailable = await createApp(userAuth(owner.id)).request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Try delivery' }),
      },
    );
    expect(unavailable.status).toBe(409);
  });
});

const mocks = vi.hoisted(() => ({
  queueReply: vi.fn(),
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/sdk/server')>();
  return { ...original, queueFastAgentSurfaceReply: mocks.queueReply };
});

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
import { fastSessionsRouter } from '..';

function createApp(authContext: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.route('/fast-sessions', fastSessionsRouter);
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

describe('Fast session MCP routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queueReply.mockResolvedValue(true);
  });

  it('returns visible transcript messages to owners and participants', async () => {
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
        `/fast-sessions/${session.id}/messages`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        returned: 1,
        messages: [
          {
            sessionId: session.id,
            text: 'Participant text',
            visibleInTranscript: true,
          },
        ],
      });
    }
  });

  it('hides sessions from non-participants and handles absent sessions', async () => {
    const owner = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createSession(owner.id);

    const inaccessible = await createApp(userAuth(bystander.id)).request(
      `/fast-sessions/${session.id}/messages`,
    );
    expect(inaccessible.status).toBe(404);

    const absent = await createApp(userAuth(owner.id)).request(
      `/fast-sessions/${crypto.randomUUID()}/messages`,
    );
    expect(absent.status).toBe(404);
  });

  it('queues participant follow-ups without granting bystander access', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createSession(owner.id);
    await addMessage({
      sessionId: session.id,
      eventId: 'participant-message',
      userId: participant.id,
    });

    const response = await createApp(userAuth(participant.id)).request(
      `/fast-sessions/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Continue this conversation' }),
      },
    );
    expect(response.status).toBe(200);
    expect(mocks.queueReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        userId: participant.id,
        question: 'Continue this conversation',
      }),
    );

    const denied = await createApp(userAuth(bystander.id)).request(
      `/fast-sessions/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Not allowed' }),
      },
    );
    expect(denied.status).toBe(404);
    expect(mocks.queueReply).toHaveBeenCalledTimes(1);
  });

  it('rejects deployment-principal runs and unavailable reply surfaces', async () => {
    const owner = await userFactory.create();
    const session = await createSession(owner.id);
    const deploymentRun: RunTokenContext = {
      runId: 1,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    };
    const denied = await createApp(deploymentRun).request(
      `/fast-sessions/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'No actor' }),
      },
    );
    expect(denied.status).toBe(403);

    mocks.queueReply.mockResolvedValueOnce(false);
    const unavailable = await createApp(userAuth(owner.id)).request(
      `/fast-sessions/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Try delivery' }),
      },
    );
    expect(unavailable.status).toBe(409);
  });
});
